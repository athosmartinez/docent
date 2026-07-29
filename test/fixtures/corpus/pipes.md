### Pipes

A pipe is a class annotated with the `@Injectable()` decorator, which implements the `PipeTransform` interface.

<figure><img class="illustrative-image" src="/assets/Pipe_1.png" /></figure>

#### Built-in pipes

Nest comes with several pipes available out-of-the-box, including `ValidationPipe` and `ParseIntPipe`.

```typescript
@@filename()
@Injectable()
export class ParseIntPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    return parseInt(value, 10);
  }
}
```
