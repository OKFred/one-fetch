export function rpcFixture(name = "of_example", overrides = {}) {
  return {
    name,
    arguments: "p_value text",
    owner: "postgres",
    security_definer: true,
    definition: `CREATE OR REPLACE FUNCTION public.${name}(p_value text)\n RETURNS text\n LANGUAGE sql\n SECURITY DEFINER\n SET search_path TO 'one_fetch', 'pg_temp'\nAS $function$ SELECT p_value $function$\n`,
    grants: [
      { grantee: "postgres", privilege: "EXECUTE", grantable: false },
      { grantee: "service_role", privilege: "EXECUTE", grantable: false },
    ],
    ...overrides,
  };
}
