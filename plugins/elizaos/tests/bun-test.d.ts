// Minimal typing for bun:test. @types/bun is not used for typecheck: its `typeof fetch` (with `preconnect`)
// rejects the bundled SDK source, which is typed against Node's fetch.
declare module "bun:test" {
  type Fn = () => unknown | Promise<unknown>;
  export function test(name: string, fn: Fn, timeout?: number): void;
  export namespace test {
    function skipIf(cond: boolean): (name: string, fn: Fn, timeout?: number) => void;
  }
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: Fn): void;
  export function afterEach(fn: Fn): void;
  export function beforeAll(fn: Fn): void;
  export function afterAll(fn: Fn): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const expect: ((actual: unknown) => any) & { arrayContaining(items: unknown[]): any; [matcher: string]: any };
}
