import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { RetrievalService } from '../src/retrieval/retrieval.service';

// Every question below is derived from an actual heading in the ingested
// corpus (see the `heading_path` column), not invented, so each one is
// demonstrably answerable rather than a guess at what might be in there.
// 30 questions spanning ~25 different documents, not just a few topics —
// the original 7-question set was too narrow to find where the two
// populations actually overlap.
const IN_CORPUS = [
  'How do I validate the request body of a POST endpoint?',
  'What options does ValidationPipe accept?',
  'How do I create a custom guard?',
  'What events does a Bull queue emit?',
  'How do I inject a repository into a service?',
  'How do I set up a global exception filter?',
  'Como eu uso o ValidationPipe?',
  'How do I read environment variables in my application?',
  'How do I upload a file?',
  "How do I validate an uploaded file's size and type?",
  'How do I set up caching in my application?',
  'How do I use the ConfigService to read configuration values?',
  'How do I schedule a cron job?',
  'How do I version my API routes by URI?',
  'How do I set a cookie on the response?',
  'How do I use sessions with Express?',
  'How do I exclude properties when serializing a response?',
  'How do I write a custom interceptor?',
  'How do I bind an interceptor to a single route handler?',
  'How do I create a custom parameter decorator?',
  'How do I connect to a MongoDB database?',
  'How do I run database migrations with TypeORM?',
  'How do I make an outgoing HTTP request from a service?',
  'How do I compress HTTP responses?',
  'How do I stream Server-Sent Events to a client?',
  'How do I build a dynamic module?',
  'How do I resolve a circular dependency between two providers?',
  'How do I write a unit test for a provider?',
  'How do I access the underlying Express request object?',
  'How do I deploy my application to production?',
];

// The original 6 were all unmistakably foreign to the corpus (geography,
// baking, Monty Python). Real refusal traffic looks more like the last two
// here: a question that sounds like it belongs — it shares vocabulary with
// a real heading — but the corpus does not actually document it. Those are
// the ones that matter for finding where the populations actually meet.
const OUT_OF_CORPUS = [
  'How do I configure a Kubernetes ingress?',
  'What is the capital of France?',
  'How do I bake sourdough bread?',
  'What is the airspeed velocity of an unladen swallow?',
  'How do I file my taxes in Brazil?',
  'Qual o melhor time de futebol de Minas Gerais?',
  'How do I train an image classifier in PyTorch?',
  "What's the best way to season a cast iron skillet?",
  'How do I set up OAuth login with Google in a Django application?',
  'How do I write a Dockerfile for a Python Flask app?',
  "What's the tallest mountain in South America?",
  'How do I calculate compound interest on a savings account?',
  // Adjacent, not covered: the corpus documents a paginated response DTO for
  // Swagger, not how to paginate a query.
  'How do I paginate results?',
  // Adjacent, not covered: file upload is documented, S3 and local cleanup
  // are not.
  'How do I upload a file to S3 and then delete the file from the local file system?',
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const retrieval = app.get(RetrievalService);

  const measure = async (label: string, questions: string[]) => {
    const distances: number[] = [];

    for (const question of questions) {
      const { bestDistance } = await retrieval.search(question);
      const distance = bestDistance ?? Number.POSITIVE_INFINITY;
      distances.push(distance);
      console.log(`${label}\t${distance.toFixed(5)}\t${question}`);
    }

    return distances;
  };

  const inside = await measure('IN ', IN_CORPUS);
  const outside = await measure('OUT', OUT_OF_CORPUS);

  const highestInside = Math.max(...inside);
  const lowestOutside = Math.min(...outside);

  console.log(`\nhighest in-corpus:  ${highestInside.toFixed(5)}`);
  console.log(`lowest out-corpus:  ${lowestOutside.toFixed(5)}`);

  if (highestInside < lowestOutside) {
    const threshold = (highestInside + lowestOutside) / 2;
    console.log(
      `separated — a threshold anywhere in [${highestInside.toFixed(5)}, ${lowestOutside.toFixed(5)}) works; midpoint ${threshold.toFixed(5)}`,
    );
  } else {
    // Overlap: some out-of-corpus questions land closer than some in-corpus
    // ones, so no single threshold gets every question right. Refusing a
    // question the corpus can actually answer costs more than answering a
    // marginal one — the whole product claim is that it answers from the
    // corpus — so the threshold is set to admit every measured in-corpus
    // question, accepting that the out-of-corpus questions below it will be
    // answered too.
    const outsideBelowHighestInside = outside.filter(
      (distance) => distance <= highestInside,
    ).length;

    console.log(
      `OVERLAP — ${outsideBelowHighestInside}/${outside.length} out-of-corpus questions fall at or below the highest in-corpus distance`,
    );
    console.log(
      `threshold set to the highest in-corpus distance measured (${highestInside.toFixed(5)}): refusing a real question costs more than answering a marginal one`,
    );
  }

  await app.close();
}

void main();
