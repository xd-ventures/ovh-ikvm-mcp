/**
 * Runtime fetcher for the AST2500 video decoder from BMC firmware.
 *
 * Instead of bundling the copyrighted AMI decoder, we fetch it at runtime
 * from the same BMC server we connect to for KVM screenshots. The decoder
 * JS is served by the BMC's web interface at /libs/kvm/ast/decode_worker.js.
 *
 * Benefits:
 * - No copyrighted code in the repository
 * - Decoder always matches the BMC firmware version
 * - Zero extra setup for users
 */

/** Decoder factory: returns a new decoder instance when called. */
// biome-ignore lint/suspicious/noExplicitAny: vendored decoder has no type definitions
type DecoderFactory = () => any;

/** In-memory cache of decoder factories, keyed by BMC host. */
const decoderCache = new Map<string, DecoderFactory>();

/** Helper classes required by the AST2500 decoder. */
const HELPER_CODE = `
	function COLOR_CACHE() { this.Index = new Uint8Array(4); this.Color = new Uint32Array(4); }
	function HuffmanTable() { this.m_success = 0; this.m_length = 0; this.m_code = 0; this.m_table = []; this.m_hufVal = 0; }
	function RC4State() { this.x = 0; this.y = 0; this.m = new Uint8Array(256); }
`;

/** Minimal ImageData shim for the AST2500 decoder. */
class ImageDataShim {
	data: Uint8ClampedArray;
	width: number;
	height: number;
	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.data = new Uint8ClampedArray(width * height * 4);
	}
}

/**
 * Fetch the AST2500 decoder JS from a BMC server and return a cached factory function.
 *
 * The decoder is fetched from `http://{host}/libs/kvm/ast/decode_worker.js` using the
 * BMC session cookie for authentication. The result is cached per host so subsequent
 * calls for the same BMC return instantly.
 *
 * @param host - BMC hostname (with optional port), e.g. "10.0.0.1" or "bmc.example.com:443"
 * @param sessionCookie - QSESSIONID cookie value for BMC authentication
 * @returns A factory function that creates new decoder instances
 */
export async function fetchDecoder(host: string, sessionCookie: string): Promise<DecoderFactory> {
	const cached = decoderCache.get(host);
	if (cached) {
		return cached;
	}

	const url = `http://${host}/libs/kvm/ast/decode_worker.js`;
	const res = await fetch(url, {
		headers: { Cookie: `QSESSIONID=${sessionCookie}` },
	});

	if (!res.ok) {
		throw new Error(`Failed to fetch decoder from ${host}: HTTP ${res.status}`);
	}

	const decoderSrc = await res.text();

	let factory: DecoderFactory;
	try {
		// Use Function constructor to avoid strict mode (decoder uses `delete` on variables)
		factory = new Function(
			"ImageData",
			`${HELPER_CODE}\n${decoderSrc}\nreturn function() { return new Decoder(); };`,
		)(ImageDataShim) as DecoderFactory;

		// Verify the factory produces something usable
		const test = factory();
		if (typeof test.setImageBuffer !== "function" || typeof test.decode !== "function") {
			throw new Error("Decoder missing required methods");
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(`Failed to initialize decoder from ${host}: ${message}`);
	}

	decoderCache.set(host, factory);
	return factory;
}

/**
 * Clear the decoder cache. Primarily useful for testing.
 */
export function clearDecoderCache(): void {
	decoderCache.clear();
}

/**
 * Create a new ImageDataShim instance for the decoder.
 * Exported so screenshot.ts can use it without duplicating the class.
 */
export function createImageData(width: number, height: number): ImageDataShim {
	return new ImageDataShim(width, height);
}
