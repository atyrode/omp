import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		await handle?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = storage!.disableCredentialById(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	test("calls onSnapshot for broker snapshots but not the constructor snapshot", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const callbacks: Array<{ snapshot: SnapshotResponse; generation: number }> = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			onSnapshot: (snapshot, generation) => {
				callbacks.push({ snapshot, generation });
			},
		});
		expect(callbacks).toHaveLength(0);

		const refreshed = await remote.refreshSnapshot();

		expect(callbacks).toHaveLength(1);
		expect(callbacks[0].generation).toBe(refreshed.generation);
		expect(callbacks[0].snapshot).toEqual(refreshed);
	});

	test("filters broker snapshots and SSE entries without narrowing the shared snapshot callback", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowedIdentity = initialResult.snapshot.credentials[0]?.identityKey;
		if (!allowedIdentity) throw new Error("expected initial credential identity");
		const identities = new Set([allowedIdentity]);
		const callbacks: SnapshotResponse[] = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			accountAllowlist: new Map([["anthropic", identities]]),
			onSnapshot: snapshot => callbacks.push(snapshot),
		});
		identities.add("identity-added-after-construction");

		expect(remote.snapshot.credentials.map(entry => entry.identityKey)).toEqual([allowedIdentity]);
		const initialGeneration = remote.snapshot.generation;

		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.generation > initialGeneration);
		expect(remote.snapshot.credentials.map(entry => entry.identityKey)).toEqual([allowedIdentity]);

		await remote.refreshSnapshot();
		expect(remote.snapshot.credentials.map(entry => entry.identityKey)).toEqual([allowedIdentity]);
		const rawIdentities = callbacks.at(-1)?.credentials.map(entry => entry.identityKey);
		expect(rawIdentities).toHaveLength(2);
		expect(rawIdentities).toContain(allowedIdentity);
	});

	test("filters aggregate usage reports through the immutable account allowlist", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowedIdentity = initialResult.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.email === "a@example.com",
		)?.identityKey;
		if (!allowedIdentity) throw new Error("expected allowed credential identity");

		const reports: UsageReport[] = [
			{ provider: "anthropic", fetchedAt: Date.now(), limits: [], metadata: { email: "a@example.com" } },
			{ provider: "anthropic", fetchedAt: Date.now(), limits: [], metadata: { email: "b@example.com" } },
			{ provider: "anthropic", fetchedAt: Date.now(), limits: [] },
		];
		vi.spyOn(client, "fetchUsage").mockResolvedValue({ generatedAt: Date.now(), reports });
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountAllowlist: new Map([["anthropic", new Set([allowedIdentity])]]),
		});

		const visible = await remote.fetchUsageReports();

		expect(visible?.map(report => report.metadata?.email)).toEqual(["a@example.com"]);

		remote.close();
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountAllowlist: new Map([["anthropic", new Set()]]),
		});
		expect(await remote.fetchUsageReports()).toEqual([]);
	});
});
