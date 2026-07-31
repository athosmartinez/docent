import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { RetrievalService } from '../src/retrieval/retrieval.service';

const IN_CORPUS = [
  'How do I validate the request body of a POST endpoint?',
  'What options does ValidationPipe accept?',
  'How do I create a custom guard?',
  'What events does a Bull queue emit?',
  'How do I inject a repository into a service?',
  'How do I set up a global exception filter?',
  'Como eu uso o ValidationPipe?',
];

const OUT_OF_CORPUS = [
  'How do I configure a Kubernetes ingress?',
  'What is the capital of France?',
  'How do I bake sourdough bread?',
  'What is the airspeed velocity of an unladen swallow?',
  'How do I file my taxes in Brazil?',
  'Qual o melhor time de futebol de Minas Gerais?',
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const retrieval = app.get(RetrievalService);

  const measure = async (label: string, questions: string[]) => {
    const scores: number[] = [];

    for (const question of questions) {
      const results = await retrieval.search(question);
      const best = results[0]?.score ?? 0;
      scores.push(best);
      console.log(`${label}\t${best.toFixed(5)}\t${question}`);
    }

    return scores;
  };

  const inside = await measure('IN ', IN_CORPUS);
  const outside = await measure('OUT', OUT_OF_CORPUS);

  const lowestInside = Math.min(...inside);
  const highestOutside = Math.max(...outside);

  console.log(`\nlowest in-corpus:   ${lowestInside.toFixed(5)}`);
  console.log(`highest out-corpus: ${highestOutside.toFixed(5)}`);
  console.log(
    lowestInside > highestOutside
      ? `separated — a floor anywhere in (${highestOutside.toFixed(5)}, ${lowestInside.toFixed(5)}] works; take the midpoint`
      : 'OVERLAP — the two populations are not separable by score alone; record this and keep the floor permissive',
  );

  await app.close();
}

void main();
