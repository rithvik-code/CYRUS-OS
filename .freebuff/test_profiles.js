// Tests for OS Phases 13 & 14 — device profiles and offline.
//
// Two claims are worth defending mechanically:
//
//  1. A profile's vault is genuinely encrypted, and a wrong passphrase fails
//     closed with a message that helps instead of a generic crypto error.
//  2. The Ollama panel does not claim to know why a local model is unreachable,
//     because from a page it genuinely cannot tell "not running" from
//     "refused by CORS". A test that let it claim certainty would be endorsing
//     exactly the overconfidence phase 11 exists to remove.
const crypto = require("crypto").webcrypto;
const { ok, eq, report, makeCtx, loadOS } = require("./os_stub.js");

async function main() {

  // ---- Vaults -------------------------------------------------------------
  {
    const ctx = makeCtx({ crypto });
    loadOS(ctx);
    const { Vaults } = ctx;

    eq(Vaults.available(), true, "WebCrypto is detected when present");
    ok(Vaults.ITER >= 100000, "PBKDF2 iteration count is not a token one", Vaults.ITER);

    const secret = '{"vfs":"my files","log":["things I did"]}';
    const blob = await Vaults.encrypt(secret, "correct horse");
    ok(typeof blob === "string", "encrypt returns a string");
    ok(!blob.includes("my files"), "the plaintext is not present in the ciphertext");

    const parsed = JSON.parse(blob);
    eq(parsed.alg, "AES-GCM", "the vault names its cipher");
    eq(parsed.kdf, "PBKDF2-SHA256", "the vault names its key derivation");
    eq(parsed.iterations, Vaults.ITER, "the vault records the iteration count so it can be raised later");
    ok(parsed.salt && parsed.iv && parsed.data, "the vault carries a salt, an IV and the data");

    // Two encryptions of the same input must differ — a reused IV would be a
    // real weakness, not a style preference.
    const blob2 = await Vaults.encrypt(secret, "correct horse");
    ok(blob2 !== blob, "encrypting twice produces different ciphertext (fresh salt and IV)");

    eq(await Vaults.decrypt(blob, "correct horse"), secret, "the right passphrase round-trips exactly");

    let wrong = null;
    try { await Vaults.decrypt(blob, "wrong"); } catch (e) { wrong = e; }
    ok(wrong !== null, "a wrong passphrase fails rather than returning garbage");
    ok(/wrong passphrase/.test(wrong && wrong.message), "and the error says why", wrong && wrong.message);

    // Empty string and unicode must survive the round trip.
    const uni = '{"emoji":"🧠","empty":"","quote":"he said \\"hi\\""}';
    eq(await Vaults.decrypt(await Vaults.encrypt(uni, "pw"), "pw"), uni, "unicode, quotes and empty strings round-trip");
  }

  // ---- Profiles -----------------------------------------------------------
  {
    const ctx = makeCtx({ crypto });
    loadOS(ctx);
    const { Profiles, VFS } = ctx;

    eq(Profiles.list().length, 0, "a fresh install has no profiles");
    ok(/no account/i.test(Profiles.blurb()), "the blurb says outright that a profile is not an account");
    ok(/cannot tell who you are/i.test(Profiles.blurb()),
       "the blurb states that a profile provides no identity", Profiles.blurb());
    ok(/this browser only/i.test(Profiles.blurb()),
       "the blurb scopes the lock to this browser", Profiles.blurb());

    const p = await Profiles.create("work", "hunter2");
    eq(p.encrypted, true, "a profile created with a passphrase is marked encrypted");
    eq(Profiles.list().length, 1, "the profile is listed");

    let dupe = null;
    try { await Profiles.create("work", "x"); } catch (e) { dupe = e; }
    ok(/already exists/.test(dupe && dupe.message), "a duplicate profile name is refused");

    // The locked profile must not be readable without the passphrase.
    const key = Profiles._vaultKey("work");
    const raw = ctx.localStorage.getItem(key);
    ok(typeof raw === "string", "the vault is persisted");
    ok(!raw.includes("notes.txt"), "the sealed vault does not contain file names in the clear");

    let noPw = await Profiles.unlock("work", "");
    eq(noPw.ok, false, "unlocking without a passphrase fails");
    let badPw = await Profiles.unlock("work", "nope");
    eq(badPw.ok, false, "unlocking with the wrong passphrase fails");

    const good = await Profiles.unlock("work", "hunter2");
    eq(good.ok, true, "unlocking with the right passphrase succeeds");
    eq(Profiles.active, "work", "the unlocked profile becomes active");
    ok(VFS.root && VFS.root.type === "dir", "the live VFS points at the loaded vault");

    // A plaintext profile must be honestly labelled, not implied to be safe.
    await Profiles.create("casual");
    eq(Profiles.get("casual").encrypted, false, "a profile with no passphrase is not marked encrypted");
    const casualRaw = ctx.localStorage.getItem(Profiles._vaultKey("casual"));
    ok(typeof casualRaw === "string" && casualRaw.includes("vfs"), "an unencrypted vault really is stored in plain text");

    ok(Profiles.remove("casual"), "a profile can be removed");
    eq(Profiles.list().length, 1, "removal takes it off the list");
    eq(ctx.localStorage.getItem(Profiles._vaultKey("casual")), null, "removal deletes the vault too");
  }

  // ---- Offline ------------------------------------------------------------
  {
    const ctx = makeCtx();  // http origin
    loadOS(ctx);
    eq(ctx.Offline.canRegister(), true, "an http origin can register a service worker");

    const cov = ctx.Offline.coverage();
    ok(cov.some(r => /cloud|need a network/i.test(r.when) && r.ok === false),
       "the coverage table marks cloud providers as needing a network");
    ok(cov.some(r => /always local/i.test(r.when) && r.ok === true),
       "the coverage table marks local state as always available");
  }
  {
    const ctx = makeCtx({ location: { protocol: "file:", host: "", port: "", origin: "null", href: "file:///x" } });
    loadOS(ctx);
    eq(ctx.Offline.canRegister(), false, "a file:// tab cannot register a service worker");
    const r = await ctx.Offline.register();
    eq(r.ok, false, "register() declines on file:// instead of throwing");
    ok(/file:\/\//.test(r.reason), "and says why in terms a user can act on", r.reason);
  }

  // ---- Ollama diagnosis ---------------------------------------------------
  {
    const ctx = makeCtx();
    loadOS(ctx);
    const D = ctx.OllamaDiag;

    eq((await D.diagnose("")).state, "no-endpoint", "no endpoint is reported as its own case");

    // Nothing listening: fetch rejects.
    const dead = await D.diagnose("http://localhost:59999");
    eq(dead.state, "unreachable", "a dead endpoint is diagnosed as unreachable");
    ok(/ollama serve/.test(dead.text), "and the fix is named", dead.text);

    // Something listening, CORS allowed: the models list comes back.
    const ctx2 = makeCtx({
      fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen2.5:3b" }] }) }),
    });
    loadOS(ctx2);
    const good = await ctx2.OllamaDiag.diagnose("http://localhost:11434");
    eq(good.state, "ok", "an allowed endpoint is diagnosed as connected");
    eq(good.models[0], "qwen2.5:3b", "and the model list comes through");

    // Something listening, but the browser refuses the reply.
    let firstCall = true;
    const ctx3 = makeCtx({
      fetch: async () => {
        if (firstCall) { firstCall = false; return { ok: true, json: async () => ({}) }; } // no-cors probe resolves
        throw new TypeError("Failed to fetch");                                                // real call is blocked
      },
    });
    loadOS(ctx3);
    const cors = await ctx3.OllamaDiag.diagnose("http://localhost:11434");
    eq(cors.state, "cors", "a CORS-blocked endpoint is distinguished from a dead one");
    ok(/OLLAMA_ORIGINS/.test(cors.text), "and the fix names the environment variable", cors.text);
    ok(/localhost:8791/.test(cors.text), "and quotes this page's actual origin", cors.text);
    ok(/export OLLAMA_ORIGINS/.test(cors.text), "and gives a shell command");
    ok(/PowerShell/.test(cors.text), "and a Windows one, because this is Windows");
    ok(!/not a network error|definitely/i.test(cors.text), "and it does not overclaim certainty", cors.text);
  }

  process.exit(report("profile + offline tests"));
}

main().catch(e => { console.error("harness crashed:", e && e.stack || e); process.exit(1); });