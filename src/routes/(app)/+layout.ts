// The app behind login is client-rendered: stores own all data fetching,
// so nothing here needs SSR. Auth is still enforced server-side by
// +layout.server.ts, which runs regardless of this flag.
export const ssr = false;
