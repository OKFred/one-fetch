import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writePackage(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "package.json"), manifest);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

export async function linkPackage(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await symlink(
    source,
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function modulesState(nodeModules, store, devDependencies) {
  return {
    included: {
      dependencies: true,
      devDependencies,
      optionalDependencies: true,
    },
    injectedDeps: {},
    layoutVersion: 5,
    nodeLinker: "isolated",
    packageManager: "pnpm@11.25.0",
    pendingBuilds: [],
    storeDir: await realpath(store),
    virtualStoreDir: await realpath(join(nodeModules, ".pnpm")),
    virtualStoreDirMaxLength: 60,
  };
}

function packageMapUrl(nodeModules, packageDirectory) {
  return `./${relative(nodeModules, packageDirectory).replaceAll("\\", "/")}`;
}

export async function createSharedDeployFixture(temporary) {
  const workspace = join(temporary, "workspace");
  const deployment = join(temporary, "deployment");
  const nodeModules = join(deployment, "node_modules");
  const virtualStore = join(nodeModules, ".pnpm");
  const aggregate = join(virtualStore, "node_modules");
  const store = join(temporary, "store", "v11");
  await Promise.all([
    mkdir(aggregate, { recursive: true }),
    mkdir(store, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const packageMap = { packages: { ".": { url: "..", dependencies: {} } } };

  async function addPackage({
    context,
    exposure,
    files = {},
    manifest,
    name,
    version,
  }) {
    const packageDirectory = join(
      virtualStore,
      context,
      "node_modules",
      ...name.split("/"),
    );
    await writePackage(
      packageDirectory,
      { name, version, ...manifest },
      { "index.js": `export default ${JSON.stringify(name)};\n`, ...files },
    );
    const exposureRoot = exposure === "direct" ? nodeModules : aggregate;
    await linkPackage(packageDirectory, join(exposureRoot, ...name.split("/")));
    packageMap.packages[context] = {
      url: packageMapUrl(nodeModules, packageDirectory),
      dependencies: { [name]: context },
    };
    return packageDirectory;
  }

  const alpha = await addPackage({
    context: "alpha@1.0.0(peer@1.0.0)",
    exposure: "direct",
    name: "alpha",
    version: "1.0.0",
  });
  const core = await addPackage({
    context: "@fixture/core@file+core",
    exposure: "direct",
    manifest: { dependencies: { "@fixture/protocol": "workspace:*" } },
    name: "@fixture/core",
    version: "0.1.0",
  });
  const beta = await addPackage({
    context: "beta@2.0.0",
    exposure: "aggregate",
    name: "beta",
    version: "2.0.0",
  });
  const protocol = await addPackage({
    context: "@fixture/protocol@file+protocol",
    exposure: "aggregate",
    name: "@fixture/protocol",
    version: "0.1.0",
  });
  await Promise.all([
    writeJson(
      join(nodeModules, ".modules.yaml"),
      await modulesState(nodeModules, store, false),
    ),
    writeJson(join(nodeModules, ".package-map.json"), packageMap),
  ]);
  return {
    addPackage,
    aggregate,
    alpha,
    beta,
    core,
    deployment,
    nodeModules,
    packageMap,
    protocol,
    store,
    virtualStore,
    workspace,
    async savePackageMap() {
      await writeJson(join(nodeModules, ".package-map.json"), packageMap);
    },
  };
}

export async function createInstalledWorkspaceFixture(temporary) {
  const workspace = join(temporary, "workspace");
  const nodeModules = join(workspace, "node_modules");
  const virtualStore = join(nodeModules, ".pnpm");
  const pnpmPackage = join(
    virtualStore,
    "pnpm@11.25.0",
    "node_modules",
    "pnpm",
  );
  const store = join(temporary, "store", "v11");
  await Promise.all([
    mkdir(join(virtualStore, "node_modules"), { recursive: true }),
    mkdir(store, { recursive: true }),
  ]);
  await writePackage(
    pnpmPackage,
    { name: "pnpm", version: "11.25.0" },
    { "bin/pnpm.cjs": "// fixture\n" },
  );
  await linkPackage(pnpmPackage, join(virtualStore, "node_modules", "pnpm"));
  const lock = "lockfileVersion: '9.0'\nfixture: true\n";
  await Promise.all([
    writeJson(join(workspace, "package.json"), {
      name: "fixture",
      packageManager: "pnpm@11.25.0",
    }),
    writeFile(join(workspace, "pnpm-lock.yaml"), lock, "utf8"),
    writeFile(join(virtualStore, "lock.yaml"), lock, "utf8"),
    writeJson(
      join(nodeModules, ".modules.yaml"),
      await modulesState(nodeModules, store, true),
    ),
  ]);
  return {
    nodeModules,
    pnpmPackage,
    store,
    virtualStore,
    workspace,
    async readModules() {
      return JSON.parse(
        await readFile(join(nodeModules, ".modules.yaml"), "utf8"),
      );
    },
    async writeModules(state) {
      await writeJson(join(nodeModules, ".modules.yaml"), state);
    },
    async replaceLink(destination, source) {
      await rm(destination, { recursive: true, force: true });
      await linkPackage(source, destination);
    },
  };
}
