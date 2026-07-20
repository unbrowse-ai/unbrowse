# Account onboarding

Install and set up the runtime:

```bash
npm install -g unbrowse@11.1.1
unbrowse setup
```

Register an account when you want shared routes, metered work, or contributor
credits:

```bash
unbrowse register --email you@example.com
```

The CLI stores the account API key locally. The bundled SDK reads the same key
from `UNBROWSE_API_KEY` or accepts it in the constructor.

```ts
import { onboardingStatus } from "unbrowse/sdk";

const status = onboardingStatus();
console.log(status.nextStep);
```

There is no separate financial onboarding. Usage and contributor credits attach
to the account automatically.
