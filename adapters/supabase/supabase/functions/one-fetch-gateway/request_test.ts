import { isRecursiveServiceTarget } from "./request.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const bases = [
  "https://project.supabase.co/functions/v1/one-fetch-control",
  "https://project.supabase.co/functions/v1/one-fetch-gateway",
];

Deno.test(
  "Recursion checks use the service path, not the whole vendor origin",
  () => {
    assert(
      isRecursiveServiceTarget(
        new URL(
          "https://project.supabase.co/functions/v1/one-fetch-gateway/loop",
        ),
        bases,
      ),
      "gateway recursion was not blocked",
    );
    assert(
      !isRecursiveServiceTarget(
        new URL("https://project.supabase.co/rest/v1/application-data"),
        bases,
      ),
      "unrelated same-project API was overblocked",
    );
  },
);
