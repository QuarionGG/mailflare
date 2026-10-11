import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderDeploymentProfile } from "./deployment-profile.mjs";

const root = process.cwd();
const destination = resolve(root, ".mailflare-deployment/wrangler.json");
const input = process.env.MAILFLARE_DEPLOYMENT_PROFILE;
if (input === undefined) {
	await rm(destination, { force: true });
	console.log("Using the existing Worker deployment configuration");
} else {
	const config = renderDeploymentProfile(input, await readFile(resolve(root, "wrangler.jsonc"), "utf8"), root);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	console.log("Private relay deployment configuration prepared");
}
