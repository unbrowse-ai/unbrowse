# unbrowse-ci-shots

CI's screenshots, for the report a pull request gets (`.github/scripts/pr_report.py`, `.github/workflows/pr-report.yml`).
GitHub draws a comment's images by fetching them unsigned, and an artifact is a zip, so each picture is put here and the
comment points at it.

- `PUT /s/<run>/<name>.(png|jpg|webp)` with `Authorization: Bearer <SHOTS_KEY>`: the bytes must be that kind of
  picture, at most 4 MB. `<run>` is 32 hex characters the uploader picks at random for its run.
- `GET /s/<run>/<name>`: the picture, to anyone. Nothing lists the bucket, so an address is only known from the comment.

Each bucket forgets a picture 14 days after it was put (an R2 lifecycle rule). Set up once per environment:

```sh
npx wrangler r2 bucket create unbrowse-ci-shots-staging
npx wrangler r2 bucket lifecycle add unbrowse-ci-shots-staging forget-after-14-days --expire-days 14 -y
npx wrangler secret put SHOTS_KEY -c wrangler.staging.jsonc       # the same value as the repository secret CI_SHOTS_KEY
gh variable set CI_SHOTS_URL --body https://unbrowse-ci-shots-staging.<subdomain>.workers.dev
```

The release train deploys the Worker (`.deploy/manifest.json`). `npm test` runs the worker against a stand-in bucket.
