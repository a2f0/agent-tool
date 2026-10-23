/** Keep machine reads free of hooks, object substitution, and signature display. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error("Invalid GIT_CONFIG_COUNT.");
  env.GIT_CONFIG_COUNT = String(count + 2);
  env[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
  env[`GIT_CONFIG_VALUE_${count}`] = "/dev/null";
  // Display banners corrupt --format output; %G? still verifies signatures.
  env[`GIT_CONFIG_KEY_${count + 1}`] = "log.showSignature";
  env[`GIT_CONFIG_VALUE_${count + 1}`] = "false";
  return env;
}
