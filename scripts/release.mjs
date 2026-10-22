// Prépare une release : `pnpm release 0.2.0`.
// Met la version à jour partout (Cargo, app, Tauri), crée le commit et le tag vX.Y.Z puis les pousse.
// Le tag déclenche .github/workflows/release.yml, qui compile, signe et publie la release GitHub.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error("Usage : pnpm release <version>   (ex. pnpm release 0.2.0)");
  process.exit(1);
}
const tag = `v${version}`;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (git("status", "--porcelain")) {
  console.error("Des modifications ne sont pas commitées : commite-les avant de publier.");
  process.exit(1);
}
if (git("branch", "--show-current") !== "main") {
  console.error("Les releases partent de la branche main.");
  process.exit(1);
}
if (git("tag", "--list", tag)) {
  console.error(`Le tag ${tag} existe déjà.`);
  process.exit(1);
}

const edit = (path, from, to) => {
  const text = readFileSync(path, "utf8");
  const next = text.replace(from, (_, head) => head + to);
  if (next === text) throw new Error(`Version introuvable dans ${path}`);
  writeFileSync(path, next);
};
edit("Cargo.toml", /(\[workspace\.package\][^[]*?version = ")[^"]+"/, `${version}"`);
edit("apps/desktop/package.json", /("version": ")[^"]+"/, `${version}"`);
edit("apps/desktop/src-tauri/tauri.conf.json", /("version": ")[^"]+"/, `${version}"`);
edit("apps/mobile/package.json", /("version": ")[^"]+"/, `${version}"`);
edit("apps/mobile/src-tauri/tauri.conf.json", /("version": ")[^"]+"/, `${version}"`);
// Répercute la nouvelle version des crates du workspace dans Cargo.lock.
execFileSync("cargo", ["update", "--workspace", "--offline"], { stdio: "inherit" });

git("add", "Cargo.toml", "Cargo.lock", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json", "apps/mobile/package.json", "apps/mobile/src-tauri/tauri.conf.json");
git("commit", "-m", `chore(release): ${tag}`);
git("tag", "-a", tag, "-m", `Zenytt ${tag}`);
execFileSync("git", ["push", "--atomic", "origin", "main", tag], { stdio: "inherit" });
console.log(`\n${tag} poussé : la release se construit sur https://github.com/NathanChevrollier/Zenytt/actions`);
