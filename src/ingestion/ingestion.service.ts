import { Inject, Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/describe-error';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../embeddings/embeddings.types';
import { chunkMarkdown } from './chunker';
import type { ChunkInput } from './ingestion.repository';
import { IngestionRepository } from './ingestion.repository';
import { loadMarkdownFiles } from './markdown-loader';
import { cleanMarkdown } from './markdown-cleaner';
import { fetchSource } from './source-fetcher';

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
    const sourceId =
      existing?.id ?? (await this.repository.createSource(uri, 'docs'));

    if (existing) {
      await this.repository.deleteSourceContent(sourceId);

      // deleteSourceContent zeroes the counts but leaves status at the
      // previous run's terminal value. runPipeline only overwrites it once
      // its own async work reaches markProcessing, which loses the race
      // against a client polling right after this call returns — that
      // window would read the old 'ready' status alongside the just-reset
      // (zero) counts. Clearing it synchronously, before the response goes
      // out, closes that window.
      await this.repository.markProcessing(sourceId, null);
    }

    void this.runPipeline(sourceId, uri, include).catch((error: unknown) => {
      this.logger.error(`ingestion failed for ${uri}: ${describeError(error)}`);
    });

    return { sourceId, status: 'pending' };
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
        try {
          const cleaned = cleanMarkdown(document.raw);
          const chunks = chunkMarkdown(cleaned.content);

          if (chunks.length === 0) {
            skipped += 1;
            continue;
          }

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
              throw new Error(
                `no embedding returned for chunk ${chunk.ordinal}`,
              );
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
        } catch (error) {
          // One unreadable document must not discard the rest of the corpus.
          skipped += 1;
          this.logger.warn(`skipped ${document.path}: ${describeError(error)}`);
        }
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
}
