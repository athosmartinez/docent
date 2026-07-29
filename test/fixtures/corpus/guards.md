### Guards

A guard is a class annotated with the `@Injectable()` decorator.

<app-banner-courses></app-banner-courses>

#### Authorization guard

Authorization is a great use case for Guards.

```typescript
@@filename(auth.guard)
import { Injectable, CanActivate } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
@@switch
import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard {
  canActivate() {
    return true;
  }
}
```

#### Binding guards

Guards can be controller-scoped, method-scoped, or global-scoped.
