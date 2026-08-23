export class ApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export class ApiClient {
	// On the server this must be the fetch provided to a load function, so
	// cookies are forwarded and relative URLs resolve during SSR. In the
	// browser the default global fetch is correct.
	constructor(private fetchFn: typeof fetch = fetch) {}

	get<T>(path: string): Promise<T> {
		return this.request('GET', path);
	}

	post<T>(path: string, body?: unknown): Promise<T> {
		return this.request('POST', path, body);
	}

	put<T>(path: string, body?: unknown): Promise<T> {
		return this.request('PUT', path, body);
	}

	patch<T>(path: string, body?: unknown): Promise<T> {
		return this.request('PATCH', path, body);
	}

	delete<T>(path: string): Promise<T> {
		return this.request('DELETE', path);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await this.fetchFn(path, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});

		if (!res.ok) {
			throw new ApiError(res.status, await errorMessage(res));
		}

		return res.status === 204 ? (undefined as T) : res.json();
	}
}

// Shared client for store methods, which only run from browser events — the
// global fetch is always correct there. Load functions must not use this:
// they create their own ApiClient(fetch) so SSR forwards cookies and inlines
// responses. Safe as a module singleton because it holds no request state.
export const api = new ApiClient();

async function errorMessage(res: Response): Promise<string> {
	try {
		const data = await res.json();
		return data.message ?? res.statusText;
	} catch {
		return res.statusText;
	}
}
