// Locks the family photos so they can live in this public repo.
// Reads the originals from family-photos/ (never committed) and writes encrypted copies to photos/.
// The password comes from photo-password.txt (never committed) or the PHOTO_PASSWORD environment variable.
// Run after adding or changing a photo:  node encrypt-photos.mjs
//
// Format: AES-256-GCM with a key from PBKDF2-SHA-256. Each .enc file is a 12-byte IV, then the
// ciphertext with its 16-byte tag, which is what the browser's WebCrypto expects (see tv.js).
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";

const SRC = new URL("./family-photos/", import.meta.url);
const OUT = new URL("./photos/", import.meta.url);
const ITERATIONS = 310000;

const fromFile = await readFile(new URL("./photo-password.txt", import.meta.url), "utf8").catch(() => "");
const password = (process.env.PHOTO_PASSWORD || fromFile).trim().normalize("NFC");
if (password.length < 10) {
  console.error("Put a password of at least 10 characters in photo-password.txt (or PHOTO_PASSWORD).");
  process.exit(1);
}

const salt = randomBytes(16);
const key = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
function seal(bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

const files = (await readdir(SRC)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
await mkdir(OUT, { recursive: true });
for (const old of await readdir(OUT)) await rm(new URL(old, OUT)); // a new salt means every file is re-locked
for (const f of files) await writeFile(new URL(f + ".enc", OUT), seal(await readFile(new URL(f, SRC))));
const manifest = { v: 1, iterations: ITERATIONS, salt: salt.toString("base64"), check: seal(Buffer.from("merry quizmas")).toString("base64"), files };
await writeFile(new URL("manifest.json", OUT), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Locked ${files.length} photos into photos/: ${files.join(", ")}`);
