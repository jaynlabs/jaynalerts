import type { NotifyOptions } from "../types.ts";

export type { NotifyOptions };

export interface Notifier {
	readonly name: string;
	isAvailable(): Promise<boolean>;
	notify(opts: NotifyOptions): Promise<void>;
}
