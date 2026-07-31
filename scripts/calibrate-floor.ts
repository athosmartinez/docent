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
  console.log(
    highestInside < lowestOutside
      ? `separated — a threshold anywhere in [${highestInside.toFixed(5)}, ${lowestOutside.toFixed(5)}) works; take the midpoint`
      : 'OVERLAP — the two populations are not separable by distance alone; record this and stop before choosing a threshold',
  );

  await app.close();
}

void main();
