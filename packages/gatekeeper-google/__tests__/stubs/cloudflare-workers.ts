// Stand-in for the `cloudflare:workers` module, which only exists inside workerd.
//
// The paging engine (gatekeeper-kit's cursors, via src/cursor.ts) declares `RpcTarget`s, so the
// suites that exercise it under plain vitest cannot import it without this. Only the base classes
// are provided, and only so that `import` and `extends` resolve -- anything that needs the real
// runtime belongs in a Workers-pool test, not here. Mirrors the mcp-shared stub.

export class DurableObject<E = unknown, P = unknown> {
  constructor(readonly ctx: unknown, readonly env: E, readonly props?: P) {}
}

export class RpcTarget {}

export class WorkerEntrypoint<E = unknown, P = unknown> {
  constructor(readonly ctx: unknown, readonly env: E, readonly props?: P) {}
}

export class RpcStub<T> {
  constructor(readonly target: T) {}
}
