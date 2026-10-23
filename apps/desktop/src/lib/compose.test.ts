import { describe, expect, it } from "vitest";
import { composeChoices, composeFileIn, containerKey, isComposeFile, projectCounts, projectDir, projectNameFromPath } from "./compose";
import type { ComposeFileInfo, ComposeFileState } from "./api";

const info = (state: ComposeFileState, hasBuild = false): ComposeFileInfo => ({ file: "/opt/app/docker-compose.yml", project: "app", hasBuild, ports: [], busyPorts: [], state });
const project = { name: "app", status: "running(1)", configFiles: "/opt/ancien/docker-compose.yml", missing: true };

describe("compose", () => {
  it("reconnaît les fichiers compose", () => {
    expect(isComposeFile("docker-compose.yml")).toBe(true);
    expect(isComposeFile("Compose.YAML")).toBe(true);
    expect(isComposeFile("docker-compose.override.yml")).toBe(false);
    expect(composeFileIn(["README.md", "compose.yaml", "docker-compose.yml"])).toBe("docker-compose.yml");
    expect(composeFileIn(["README.md"])).toBeUndefined();
  });

  it("propose les actions selon ce qui tourne déjà", () => {
    expect(composeChoices(info({ kind: "invalid", message: "x" }))).toEqual([]);
    expect(composeChoices(info({ kind: "notRunning" }))).toEqual(["launch"]);
    expect(composeChoices(info({ kind: "notRunning" }, true))).toEqual(["launch", "launchBuild"]);
    expect(composeChoices(info({ kind: "same", project, running: true }))).toEqual(["restart", "update", "rebuild", "logs", "stop"]);
    expect(composeChoices(info({ kind: "same", project, running: false }))).toEqual(["start", "down"]);
    expect(composeChoices(info({ kind: "same", project, running: false }, true))).toEqual(["launchBuild", "down"]);
    expect(composeChoices(info({ kind: "conflict", project }))).toEqual(["replace", "launchAs"]);
  });
});


describe("conteneurs ponctuels", () => {
  const svc = (service: string, state: string) => ({ name: `infra_${service}_1`, state, composeProject: "infra", composeService: service });

  it("identifie un conteneur compose par projet et service", () => {
    expect(containerKey(svc("migrator", "exited"))).toBe("infra/migrator");
    expect(containerKey({ name: "seul", composeProject: null, composeService: null })).toBe("seul");
  });

  it("ne compte pas les conteneurs ponctuels", () => {
    const services = [svc("api", "running"), svc("db", "running"), svc("migrator", "exited")];
    expect(projectCounts(services, new Set())).toEqual({ running: 2, expected: 3, occasional: 0 });
    expect(projectCounts(services, new Set(["infra/migrator"]))).toEqual({ running: 2, expected: 2, occasional: 1 });
  });
});

describe("nom de projet depuis le dossier", () => {
  it("prend le dernier segment, nettoyé", () => {
    expect(projectNameFromPath("/opt/stacks/Mon App/")).toBe("mon-app");
    expect(projectNameFromPath("/srv/clients/Café_Du.Coin")).toBe("cafe_du-coin");
    expect(projectNameFromPath("/opt/.cache")).toBe("cache");
    expect(projectNameFromPath("/")).toBe("");
    expect(projectNameFromPath("/opt/" + "a".repeat(60)).length).toBe(40);
  });
  it("donne le dossier du fichier compose", () => {
    expect(projectDir({ configFiles: "/opt/app/docker-compose.yml,/opt/app/override.yml" })).toBe("/opt/app");
    expect(projectDir({ configFiles: "/compose.yml" })).toBe("/");
  });
});
