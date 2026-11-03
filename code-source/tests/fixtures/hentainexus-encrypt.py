# Chiffreur de référence, porté indépendamment depuis Utils.kt (Mihon / keiyoushi, HentaiNexus).
# Le flot de clés ne dépend que des 64 octets de clé : chiffrer = XOR avec le même flot.
import base64, json, random, sys

PRIMES = [2, 3, 5, 7, 11, 13, 17, 19]

def keystream(key64, length):
    prime_idx = 0
    for i in range(64):
        prime_idx ^= key64[i]
        for _ in range(8):
            prime_idx = ((prime_idx >> 1) ^ 12) if (prime_idx & 1) else (prime_idx >> 1)
    prime_idx &= 7
    digest = list(range(256))
    key = 0
    for i in range(256):
        key = (key + digest[i] + key64[i % 64]) % 256
        digest[i], digest[key] = digest[key], digest[i]
    q = PRIMES[prime_idx]
    k = n = p = xor_key = 0
    out = []
    for _ in range(length):
        k = (k + q) % 256
        n = (p + digest[(n + digest[k]) % 256]) % 256
        p = (p + k + digest[k]) % 256
        digest[k], digest[n] = digest[n], digest[k]
        xor_key = digest[(n + digest[(k + digest[(xor_key + p) % 256]) % 256]) % 256]
        out.append(xor_key)
    return out

def encrypt(plain: str, hostname: str, seed: int) -> str:
    rnd = random.Random(seed)
    key64 = [rnd.randrange(256) for _ in range(64)]
    pb = plain.encode('latin-1')
    ks = keystream(key64, len(pb))
    cipher = [b ^ x for b, x in zip(pb, ks)]
    head = list(key64)
    for i, c in enumerate(hostname):
        head[i] ^= ord(c)
    return base64.b64encode(bytes(head + cipher)).decode()

if __name__ == '__main__':
    out = {}
    pages = [{"type": "image", "label": str(i + 1), "image_fallback": f"https://i0.wp.com/images.hentainexus.com/v2/gx/{i + 1:03d}.webp", "image_avif": f"https://cdn.hentainexus.com/{i + 1}.avif"} for i in range(6)]
    pages.insert(3, {"type": "advertisement", "url": "https://ads.example/x.jpg"})
    for seed in range(5):
        out[f"seed{seed}"] = {"plain": json.dumps(pages), "enc": encrypt(json.dumps(pages), "hentainexus.com", seed)}
    out["other_host"] = {"plain": json.dumps(pages), "enc": encrypt(json.dumps(pages), "other.example", 7)}
    json.dump(out, sys.stdout)
