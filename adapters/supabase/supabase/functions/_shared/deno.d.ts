declare const Deno: {
  readonly env: {
    get(name: string): string | undefined;
  };
  test(name: string, test: () => void | Promise<void>): void;
};
