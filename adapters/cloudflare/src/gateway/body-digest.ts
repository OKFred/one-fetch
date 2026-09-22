/** Hash incrementally in workerd without buffering or an unbounded tee branch. */
export function responseBodyDigest() {
  // lib.webworker declares the global crypto with its narrower Web-standard type.
  // The constructor type below comes from Wrangler's generated workerd runtime.
  const workerCrypto = crypto as typeof crypto & {
    DigestStream: typeof DigestStream;
  };
  const stream = new workerCrypto.DigestStream("SHA-256");
  const writer = stream.getWriter();
  // Cancellation rejects digest independently of writer.abort(). Observe it immediately.
  const result = stream.digest.then(
    (bytes) =>
      Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    () => undefined,
  );
  return {
    write: (bytes: Uint8Array) => writer.write(bytes),
    async finish(): Promise<string> {
      await writer.close();
      const hash = await result;
      if (hash === undefined) throw new Error("Response digest unavailable");
      return hash;
    },
    async abort(): Promise<void> {
      await writer.abort().catch(() => undefined);
      await result;
    },
  };
}
