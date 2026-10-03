/** Disable object substitution and hooks, retaining existing Git config overrides. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error("Invalid GIT_CONFIG_COUNT.");
  env.GIT_CONFIG_COUNT = String(count + 1);
  env[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
  env[`GIT_CONFIG_VALUE_${count}`] = "/dev/null";
  return env;
}
