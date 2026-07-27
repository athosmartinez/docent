import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/describe-error';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../embeddings/embeddings.types';
import type { Chunk } from './chunker';
import { chunkMarkdown } from './chunker';
import type { ChunkInput, SourceRow } from './ingestion.repository';
import { IngestionRepository } from './ingestion.repository';
import { loadMarkdownFiles } from './markdown-loader';
import type { CleanedMarkdown } from './markdown-cleaner';
import { cleanMarkdown } from './markdown-cleaner';
import { fetchSource } from './source-fetcher';

/** Postgres' error code for a unique-constraint violation. */
const UNIQUE_VIOLATION_CODE = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

/** A source in either state already has a pipeline running against it. */
const RUNNING_STATUSES = new Set(['pending', 'processing']);

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly repository: IngestionRepository,
    @Inject(EMBEDDINGS) private readonly embeddings: EmbeddingsProvider,
  ) {}

  /**
   * Registers the source and returns immediately. Embedding several hundred
   * chunks takes minutes, which no HTTP client should hold a connection open
   * for.
   */
  async startIngestion(
    uri: string,
    include: string,
  ): Promise<{ sourceId: string; status: string }> {
    const existing = await this.repository.findSourceByUri(uri);

    if (existing) {
      return this.reuse(existing, uri, include);
    }

    try {
      const sourceId = await this.repository.createSource(uri, 'docs');

      this.launch(sourceId, uri, include);

      return { sourceId, status: 'pending' };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Another request for the same URI won the insert race — `sources.uri`
      // is unique — so fall back to the row it created instead of
      // surfacing the constraint violation as a raw 500.
      const winner = await this.repository.findSourceByUri(uri);

      if (!winner) {
        throw error;
      }

      return this.reuse(winner, uri, include);
    }
  }

  /**
   * Starts (or restarts) a pipeline against an already-known row. Two
   * concurrent requests for the same URI both resolve here — reusing the
   * same row on their own path, or via the other's unique-violation
   * fallback above — so this is the one place that has to refuse a
   * duplicate run.
   */
  private async reuse(
    source: SourceRow,
    uri: string,
    include: string,
  ): Promise<{ sourceId: string; status: string }> {
    if (RUNNING_STATUSES.has(source.status)) {
      throw new ConflictException(`ingestion already in progress for ${uri}`);
    }

    // Order matters: flipping status off its previous terminal value before
    // the counts are cleared means no reader can observe a 'ready' (or
    // 'failed') status paired with zeroed counts — the interim state is
    // 'processing' with stale-but-nonzero counts, which is honest (work is
    // in progress), never "done with nothing in it".
    await this.repository.markProcessing(source.id, null);
    await this.repository.deleteSourceContent(source.id);

    this.launch(source.id, uri, include);

    return { sourceId: source.id, status: 'pending' };
  }

  private launch(sourceId: string, uri: string, include: string): void {
    void this.runPipeline(sourceId, uri, include).catch((error: unknown) => {
      this.logger.error(`ingestion failed for ${uri}: ${describeError(error)}`);
    });
  }

  async runPipeline(
    sourceId: string,
    uri: string,
    include: string,
  ): Promise<void> {
    let cleanup: (() => Promise<void>) | null = null;

    try {
      const fetched = await fetchSource(uri);
      cleanup = fetched.cleanup;

      await this.repository.markProcessing(sourceId, fetched.commitSha);

      const documents = await loadMarkdownFiles(fetched.directory, include);
      let skipped = 0;

      for (const document of documents) {
        const parsed = this.parseDocument(document.raw, document.path);

        if (parsed === null || parsed.chunks.length === 0) {
          skipped += 1;
          continue;
        }

        const { cleaned, chunks } = parsed;

        // A database or embedding-provider failure below is infrastructure,
        // not a property of this one document, so it is deliberately left
        // uncaught here — it reaches the outer catch and fails the whole
        // source, rather than silently shrinking the index by one document
        // while the source reports itself 'ready'.
        const vectors = await this.embeddings.embed(
          chunks.map((chunk) => chunk.content),
        );

        // Bare `@@filename()` directives (Nest's "no dedicated file" marker)
        // clean to empty strings; storing those as metadata would be noise.
        const filenames = cleaned.filenames.filter(
          (filename) => filename.length > 0,
        );

        const inputs: ChunkInput[] = chunks.map((chunk, index) => {
          const embedding = vectors[index];

          if (embedding === undefined) {
            throw new Error(`no embedding returned for chunk ${chunk.ordinal}`);
          }

          return {
            ordinal: chunk.ordinal,
            content: chunk.content,
            headingPath: chunk.headingPath,
            tokenCount: chunk.tokenCount,
            embedding,
            metadata: filenames.length > 0 ? { filenames } : {},
          };
        });

        await this.repository.insertDocumentWithChunks(
          sourceId,
          { path: document.path, title: document.title },
          inputs,
        );
      }

      await this.repository.recordSkipped(sourceId, skipped);
      await this.repository.markReady(sourceId);
      this.logger.log(
        `ingested ${uri}: ${documents.length - skipped} documents`,
      );
    } catch (error) {
      await this.repository.markFailed(sourceId, describeError(error));
      throw error;
    } finally {
      if (cleanup) {
        await cleanup();
      }
    }
  }

  /**
   * Malformed markdown is a property of this one document, not the run: note
   * it and move on. A failure past this point (embedding, the database) is
   * infrastructure and must not be caught the same way — see the uncaught
   * region in `runPipeline`.
   */
  private parseDocument(
    raw: string,
    path: string,
  ): { cleaned: CleanedMarkdown; chunks: Chunk[] } | null {
    try {
      const cleaned = cleanMarkdown(raw);
      const chunks = chunkMarkdown(cleaned.content);

      return { cleaned, chunks };
    } catch (error) {
      this.logger.warn(`skipped ${path}: ${describeError(error)}`);

      return null;
    }
  }
}
