import type { ThroughputPrecision } from "./types.js";

export const THROUGHPUT_PRECISION_DESCRIPTOR = {
	defaultValue: "auto" as const,
	values: ["auto", 1, 0] as const satisfies readonly ThroughputPrecision[],
	normalize(value: unknown): ThroughputPrecision {
		return value === "auto" || value === 1 || value === 0 ? value : "auto";
	},
	label(value: ThroughputPrecision): string {
		switch (value) {
			case "auto":
				return "auto";
			case 1:
				return "1 digit";
			case 0:
				return "0 digits";
		}
	},
	next(value: ThroughputPrecision): ThroughputPrecision {
		switch (value) {
			case "auto":
				return 1;
			case 1:
				return 0;
			case 0:
				return "auto";
		}
	},
} as const;
