import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	type AuthBrokerServerHandle,
	readAuthBrokerSnapshotCache,
	type SnapshotResponse,
	startAuthBroker,
	writeAuthBrokerSnapshotCache,
} from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
	"OMP_AUTH_BROKER_SNAPSHOT_TTL_MS",
	"OMP_AUTH_ACCOUNT_ALLOWLIST_FILE",
] as const;
const PROVIDER = "unit-auth-broker-cache";
const TOKEN = "coding-agent-cache-token";
const OAUTH_PROVIDER = "openai-codex";
const API_KEY_PROVIDER = "unit-auth-broker-unrestricted-api";

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function makeSnapshot(urlTime: number): SnapshotResponse {
	return {
		generation: 11,
		generatedAt: urlTime,
		serverNowMs: urlTime,
		refresher: {
			enabled: false,
			intervalMs: 60_000,
			skewMs: 300_000,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [
			{
				id: 1,
				provider: PROVIDER,
				credential: { type: "api_key", key: "cached-api-key" },
				identityKey: null,
				rotatesInMs: null,
			},
		],
	};
}

function makeOAuthSnapshot(urlTime: number): SnapshotResponse {
	const snapshot = makeSnapshot(urlTime);
	return {
		...snapshot,
		credentials: [
			...snapshot.credentials,
			{
				id: 2,
				provider: OAUTH_PROVIDER,
				credential: {
					type: "oauth",
					access: "allowed-access",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: urlTime + 3_600_000,
					accountId: "allowed",
				},
				identityKey: "account:allowed",
				rotatesInMs: 3_600_000,
			},
			{
				id: 3,
				provider: OAUTH_PROVIDER,
				credential: {
					type: "oauth",
					access: "excluded-access",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: urlTime + 3_600_000,
					accountId: "excluded",
				},
				identityKey: "account:excluded",
				rotatesInMs: 3_600_000,
			},
		],
	};
}

async function configureAllowlist(tempDir: string, identities: readonly string[]): Promise<string> {
	const policyPath = path.join(tempDir, `allowlist-${identities.length}.json`);
	await Bun.write(policyPath, JSON.stringify({ [OAUTH_PROVIDER]: identities }));
	process.env.OMP_AUTH_ACCOUNT_ALLOWLIST_FILE = policyPath;
	return policyPath;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	if (!(await predicate())) throw new Error("waitUntil timeout");
}

describe("discoverAuthStorage auth-broker snapshot cache", () => {
	let tempDir = "";

	beforeEach(async () => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-auth-broker-cache-"));
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		await removeWithRetries(tempDir);
	});

	test("boots from a fresh encrypted cache when the broker is down", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const downUrl = "http://127.0.0.1:1";
		process.env.OMP_AUTH_BROKER_URL = downUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
		await writeAuthBrokerSnapshotCache({
			path: cachePath,
			token: TOKEN,
			url: downUrl,
			snapshot: makeSnapshot(Date.now()),
		});

		const storage = await discoverAuthStorage(tempDir);
		try {
			expect(await storage.getApiKey(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage.close();
		}
	});

	test("filters excluded OAuth accounts from a stale encrypted cache while preserving API keys", async () => {
		const cachePath = path.join(tempDir, "stale-snapshot.enc");
		const downUrl = "http://127.0.0.1:1";
		process.env.OMP_AUTH_BROKER_URL = downUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
		await configureAllowlist(tempDir, ["account:allowed"]);
		await writeAuthBrokerSnapshotCache({
			path: cachePath,
			token: TOKEN,
			url: downUrl,
			snapshot: makeOAuthSnapshot(Date.now()),
		});

		const storage = await discoverAuthStorage(tempDir);
		try {
			expect(storage.listOAuthAccounts(OAUTH_PROVIDER).map(account => account.accountId)).toEqual(["allowed"]);
			expect(await storage.getApiKey(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage.close();
		}
	});

	test("a restricted peer cannot replace the shared cache with its filtered view", async () => {
		const cachePath = path.join(tempDir, "shared-snapshot.enc");
		const downUrl = "http://127.0.0.1:1";
		process.env.OMP_AUTH_BROKER_URL = downUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
		await writeAuthBrokerSnapshotCache({
			path: cachePath,
			token: TOKEN,
			url: downUrl,
			snapshot: makeOAuthSnapshot(Date.now()),
		});
		const initialCacheInode = (await fs.stat(cachePath)).ino;
		await configureAllowlist(tempDir, ["account:allowed"]);

		let restrictedStorage: AuthStorage | undefined;
		let peerStorage: AuthStorage | undefined;
		try {
			restrictedStorage = await discoverAuthStorage(tempDir);
			expect(restrictedStorage.listOAuthAccounts(OAUTH_PROVIDER).map(account => account.accountId)).toEqual([
				"allowed",
			]);

			await waitUntil(async () => (await fs.stat(cachePath)).ino !== initialCacheInode);

			delete process.env.OMP_AUTH_ACCOUNT_ALLOWLIST_FILE;
			peerStorage = await discoverAuthStorage(tempDir);
			expect(
				peerStorage
					.listOAuthAccounts(OAUTH_PROVIDER)
					.map(account => account.accountId)
					.sort(),
			).toEqual(["allowed", "excluded"]);
			expect(restrictedStorage.listOAuthAccounts(OAUTH_PROVIDER).map(account => account.accountId)).toEqual([
				"allowed",
			]);
		} finally {
			peerStorage?.close();
			restrictedStorage?.close();
		}
	});

	test("an empty provider allowlist removes every cached OAuth account", async () => {
		const cachePath = path.join(tempDir, "empty-allowlist-snapshot.enc");
		const downUrl = "http://127.0.0.1:1";
		process.env.OMP_AUTH_BROKER_URL = downUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
		await configureAllowlist(tempDir, []);
		await writeAuthBrokerSnapshotCache({
			path: cachePath,
			token: TOKEN,
			url: downUrl,
			snapshot: makeOAuthSnapshot(Date.now()),
		});

		const storage = await discoverAuthStorage(tempDir);
		try {
			expect(storage.listOAuthAccounts(OAUTH_PROVIDER)).toEqual([]);
			expect(await storage.getApiKey(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage.close();
		}
	});

	test("seeds the encrypted cache after an initial broker fetch", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		brokerStore.saveApiKey(PROVIDER, "broker-api-key");
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
		let handle: AuthBrokerServerHandle | undefined;
		let storage: AuthStorage | undefined;
		try {
			handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [TOKEN],
				disableRefresher: true,
			});
			process.env.OMP_AUTH_BROKER_URL = handle.url;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";

			storage = await discoverAuthStorage(tempDir);
			expect(await storage.getApiKey(PROVIDER)).toBe("broker-api-key");
			await waitUntil(async () => {
				const cached = await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: handle!.url,
					ttlMs: 3_600_000,
				});
				return cached?.credentials.some(entry => entry.provider === PROVIDER) ?? false;
			});
			const cached = await readAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: handle.url,
				ttlMs: 3_600_000,
			});
			const entry = cached?.credentials.find(candidate => candidate.provider === PROVIDER);
			expect(entry?.credential).toEqual({ type: "api_key", key: "broker-api-key" });
		} finally {
			storage?.close();
			await handle?.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});
	test("filters live broker snapshots without mutating the shared cache or upstream credentials", async () => {
		const cachePath = path.join(tempDir, "filtered-live-snapshot.enc");
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "filtered-broker.db"));
		const expires = Date.now() + 3_600_000;
		brokerStore.saveOAuth(OAUTH_PROVIDER, {
			access: "allowed-access",
			refresh: "allowed-refresh",
			expires,
			accountId: "allowed",
		});
		brokerStore.saveOAuth(OAUTH_PROVIDER, {
			access: "excluded-access",
			refresh: "excluded-refresh",
			expires,
			accountId: "excluded",
		});
		brokerStore.saveApiKey(API_KEY_PROVIDER, "unrestricted-api-key");
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
		let handle: AuthBrokerServerHandle | undefined;
		let storage: AuthStorage | undefined;
		try {
			handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [TOKEN],
				disableRefresher: true,
			});
			process.env.OMP_AUTH_BROKER_URL = handle.url;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
			const policyPath = await configureAllowlist(tempDir, ["account:allowed"]);

			storage = await discoverAuthStorage(tempDir);
			expect(storage.listOAuthAccounts(OAUTH_PROVIDER).map(account => account.accountId)).toEqual(["allowed"]);
			expect(await storage.getApiKey(API_KEY_PROVIDER)).toBe("unrestricted-api-key");

			await Bun.write(policyPath, JSON.stringify({ [OAUTH_PROVIDER]: [] }));
			expect(storage.listOAuthAccounts(OAUTH_PROVIDER).map(account => account.accountId)).toEqual(["allowed"]);
			expect(
				brokerStore
					.listAuthCredentials(OAUTH_PROVIDER)
					.flatMap(entry => (entry.credential.type === "oauth" ? [entry.credential.accountId] : []))
					.sort(),
			).toEqual(["allowed", "excluded"]);

			await waitUntil(async () => {
				const cached = await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: handle!.url,
					ttlMs: 3_600_000,
				});
				return cached?.credentials.some(entry => entry.provider === OAUTH_PROVIDER) ?? false;
			});
			const cached = await readAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: handle.url,
				ttlMs: 3_600_000,
			});
			expect(
				cached?.credentials
					.filter(entry => entry.provider === OAUTH_PROVIDER)
					.map(entry => entry.identityKey)
					.sort(),
			).toEqual(["account:allowed", "account:excluded"]);
			expect(cached?.credentials.some(entry => entry.provider === API_KEY_PROVIDER)).toBe(true);
		} finally {
			storage?.close();
			await handle?.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});
});
