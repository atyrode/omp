import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthAccountAllowlist,
	type AuthCredentialStore,
	AuthStorage,
	type OAuthCredential,
	resolveCredentialIdentityKey,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-oauth-identity";

function oauthCredential(accountId?: string, expires = Date.now() + 60 * 60_000): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${accountId ?? "anonymous"}`,
		refresh: `refresh-${accountId ?? "anonymous"}`,
		expires,
		...(accountId ? { accountId, email: `${accountId}@example.com` } : {}),
	};
}

describe("AuthStorage.getOAuthAccountIdentity", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-identity-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("returns undefined without OAuth credentials", () => {
		if (!authStorage) throw new Error("test setup failed");
		expect(authStorage.getOAuthAccountIdentity(PROVIDER)).toBeUndefined();
	});

	test("carries accountId, email, and projectId from the active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
				projectId: "gcp-project-a",
			},
		]);
		expect(authStorage.getOAuthAccountIdentity(PROVIDER)).toEqual({
			accountId: "acc-a",
			email: "a@example.com",
			projectId: "gcp-project-a",
		});
	});

	test("drops empty-string fields and returns undefined when no field survives", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "",
				email: "",
			},
		]);
		expect(authStorage.getOAuthAccountIdentity(PROVIDER)).toBeUndefined();
	});

	test("follows the session-sticky credential across rotation", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const sessionId = "session-identity-test";
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-b",
				email: "b@example.com",
			},
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const firstKey = await storage.getApiKey(PROVIDER, sessionId);
		const firstIdentity = storage.getOAuthAccountIdentity(PROVIDER, sessionId);
		expect(firstIdentity?.accountId).toBeDefined();
		// Identity must describe the credential the session is actually using.
		expect(firstIdentity?.accountId).toBe(firstKey === "access-a" ? "acc-a" : "acc-b");

		const invalidated = await storage.invalidateCredentialMatching(PROVIDER, firstKey ?? "", { sessionId });
		expect(invalidated).toBe(true);
		const retryKey = await storage.getApiKey(PROVIDER, sessionId);
		expect(retryKey).not.toBe(firstKey);
		const rotatedIdentity = storage.getOAuthAccountIdentity(PROVIDER, sessionId);
		expect(rotatedIdentity?.accountId).toBe(retryKey === "access-a" ? "acc-a" : "acc-b");
	});

	test("config override suppresses OAuth identity attribution", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
		]);
		expect(authStorage.getOAuthAccountIdentity(PROVIDER)?.accountId).toBe("acc-a");

		authStorage.setConfigApiKey(PROVIDER, "gateway-bearer");
		// With an explicit bearer in play the session is not using OAuth, so no
		// account may be reported as "in use".
		expect(authStorage.getOAuthAccountIdentity(PROVIDER)).toBeUndefined();
	});

	test("removes one stored OAuth credential without clearing sibling accounts", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-b",
				email: "b@example.com",
			},
		]);
		const before = authStorage.listStoredCredentials(PROVIDER);
		const target = before.find(row => row.credential.type === "oauth" && row.credential.accountId === "acc-a");
		if (!target) throw new Error("missing target credential");

		const removed = await authStorage.removeCredential(PROVIDER, target.id);

		expect(removed).toBe(true);
		const after = authStorage.listStoredCredentials(PROVIDER);
		expect(after.map(row => (row.credential.type === "oauth" ? row.credential.accountId : ""))).toEqual(["acc-b"]);
		expect(await authStorage.removeCredential(PROVIDER, target.id)).toBe(false);
	});

	describe("account allowlist", () => {
		test("leaves providers absent from the policy unrestricted", async () => {
			if (!store || !authStorage) throw new Error("test setup failed");
			await authStorage.set(PROVIDER, [oauthCredential("acc-a"), oauthCredential("acc-b")]);

			const restricted = new AuthStorage(store, {
				accountAllowlist: new Map([["some-other-provider", new Set<string>()]]),
			});
			await restricted.reload();

			expect(restricted.listOAuthAccounts(PROVIDER).map(account => account.accountId)).toEqual(["acc-a", "acc-b"]);
		});

		test("exposes only the selected identity and defensively copies the policy", async () => {
			if (!store || !authStorage) throw new Error("test setup failed");
			const selected = oauthCredential("acc-b");
			const selectedIdentity = resolveCredentialIdentityKey(PROVIDER, selected);
			if (!selectedIdentity) throw new Error("missing test identity");
			await authStorage.set(PROVIDER, [oauthCredential("acc-a"), selected]);

			const identities = new Set([selectedIdentity]);
			const accountAllowlist: AuthAccountAllowlist = new Map([[PROVIDER, identities]]);
			const restricted = new AuthStorage(store, { accountAllowlist });
			identities.add(resolveCredentialIdentityKey(PROVIDER, oauthCredential("acc-a"))!);
			await restricted.reload();
			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
				const credential = credentials[provider];
				return credential ? { newCredentials: credential, apiKey: credential.access } : null;
			});

			expect(restricted.listOAuthAccounts(PROVIDER).map(account => account.accountId)).toEqual(["acc-b"]);
			expect(await restricted.getApiKey(PROVIDER)).toBe("access-acc-b");
		});

		test("an explicit empty set hides OAuth and leaves API keys visible", async () => {
			if (!store) throw new Error("test setup failed");
			const restricted = new AuthStorage(store, {
				accountAllowlist: new Map([[PROVIDER, new Set<string>()]]),
			});

			await restricted.set(PROVIDER, [oauthCredential("acc-a"), { type: "api_key", key: "stored-api-key" }]);

			expect(restricted.listOAuthAccounts(PROVIDER)).toEqual([]);
			expect(restricted.listStoredCredentials(PROVIDER).map(row => row.credential.type)).toEqual(["api_key"]);
			expect(store.listAuthCredentials(PROVIDER).map(row => row.credential.type)).toEqual(["oauth", "api_key"]);
		});

		test("excludes OAuth credentials whose canonical identity is null", async () => {
			if (!store || !authStorage) throw new Error("test setup failed");
			await authStorage.set(PROVIDER, oauthCredential());
			const restricted = new AuthStorage(store, {
				accountAllowlist: new Map([[PROVIDER, new Set(["account:any"])]]),
			});

			await restricted.reload();

			expect(restricted.listStoredCredentials(PROVIDER)).toEqual([]);
			expect(store.listAuthCredentials(PROVIDER)).toHaveLength(1);
		});

		test("never refreshes or probes excluded rows and does not mutate backing rows", async () => {
			if (!store || !authStorage) throw new Error("test setup failed");
			const allowed = oauthCredential("acc-allowed");
			const excluded = oauthCredential("acc-excluded", Date.now() - 1);
			const anonymous = oauthCredential(undefined, Date.now() - 1);
			await authStorage.set(PROVIDER, [allowed, excluded, anonymous]);
			const backingBefore = store.listAuthCredentials(PROVIDER);
			const allowedIdentity = resolveCredentialIdentityKey(PROVIDER, allowed);
			if (!allowedIdentity) throw new Error("missing test identity");
			const refreshOAuthCredential = vi.fn(async () => {
				throw new Error("excluded credential was refreshed");
			});
			const completionProbe = vi.fn(async () => ({ ok: true as const }));
			const restricted = new AuthStorage(store, {
				accountAllowlist: new Map([[PROVIDER, new Set([allowedIdentity])]]),
				refreshOAuthCredential,
			});
			await restricted.reload();

			const health = await restricted.checkCredentials({ completionProbe });
			const excludedRow = backingBefore.find(
				row => row.credential.type === "oauth" && row.credential.accountId === "acc-excluded",
			);
			if (!excludedRow) throw new Error("missing excluded test row");
			await expect(restricted.forceRefreshCredentialById(excludedRow.id)).rejects.toThrow(
				`No credential with id=${excludedRow.id}`,
			);

			expect(health.map(result => result.accountId)).toEqual(["acc-allowed"]);
			expect(completionProbe).toHaveBeenCalledTimes(1);
			expect(refreshOAuthCredential).not.toHaveBeenCalled();
			expect(store.listAuthCredentials(PROVIDER)).toEqual(backingBefore);
			expect(restricted.exportSnapshot().credentials.map(entry => entry.identityKey)).toEqual([allowedIdentity]);
		});
	});
});
