import type { GlancePalette } from "./types.js";

export type GlanceThemeCatalogEntry = {
	id: string;
	label: string;
	group: "core" | "catppuccin" | "classic" | "editor" | "kanagawa" | "everforest" | "accessibility";
	groupLabel: string;
	tone: "light" | "dark";
	tags: readonly string[];
	detailTags: readonly string[];
	description: string;
	detailDescription: string;
	palette: GlancePalette;
};

export const GLANCE_THEME_CATALOG = [
	{
		"id": "light",
		"label": "Light",
		"group": "core",
		"groupLabel": "Core",
		"tone": "light",
		"tags": [
			"default",
			"bright",
			"neutral"
		],
		"detailTags": [
			"default",
			"bright",
			"neutral"
		],
		"description": "Bright neutral palette for well-lit terminals.",
		"detailDescription": "Bright neutral palette for well-lit terminals.",
		"palette": {
			"text": {
				"r": 15,
				"g": 23,
				"b": 42
			},
			"dim": {
				"r": 148,
				"g": 163,
				"b": 184
			},
			"warn": {
				"r": 217,
				"g": 119,
				"b": 6
			},
			"error": {
				"r": 225,
				"g": 29,
				"b": 72
			},
			"separator": {
				"r": 148,
				"g": 163,
				"b": 184
			},
			"border": {
				"r": 72,
				"g": 94,
				"b": 84
			},
			"title": {
				"r": 47,
				"g": 104,
				"b": 74
			},
			"segments": {
				"git": {
					"fg": {
						"r": 35,
						"g": 118,
						"b": 85
					}
				},
				"model": {
					"fg": {
						"r": 15,
						"g": 23,
						"b": 42
					}
				},
				"context": {
					"fg": {
						"r": 5,
						"g": 150,
						"b": 105
					}
				},
				"tokens": {
					"fg": {
						"r": 100,
						"g": 116,
						"b": 139
					}
				},
				"cost": {
					"fg": {
						"r": 154,
						"g": 104,
						"b": 20
					}
				},
				"throughput": {
					"fg": {
						"r": 100,
						"g": 116,
						"b": 139
					}
				}
			}
		}
	},
	{
		"id": "dark",
		"label": "Dark",
		"group": "core",
		"groupLabel": "Core",
		"tone": "dark",
		"tags": [
			"default",
			"dark",
			"neutral"
		],
		"detailTags": [
			"default",
			"neutral"
		],
		"description": "Neutral dark palette for low-light terminals.",
		"detailDescription": "Neutral dim palette for dim terminals.",
		"palette": {
			"text": {
				"r": 229,
				"g": 231,
				"b": 235
			},
			"dim": {
				"r": 107,
				"g": 114,
				"b": 128
			},
			"warn": {
				"r": 251,
				"g": 191,
				"b": 36
			},
			"error": {
				"r": 251,
				"g": 113,
				"b": 133
			},
			"separator": {
				"r": 75,
				"g": 85,
				"b": 99
			},
			"border": {
				"r": 104,
				"g": 132,
				"b": 119
			},
			"title": {
				"r": 104,
				"g": 152,
				"b": 129
			},
			"segments": {
				"git": {
					"fg": {
						"r": 94,
						"g": 188,
						"b": 145
					}
				},
				"model": {
					"fg": {
						"r": 229,
						"g": 231,
						"b": 235
					}
				},
				"context": {
					"fg": {
						"r": 52,
						"g": 211,
						"b": 153
					}
				},
				"tokens": {
					"fg": {
						"r": 156,
						"g": 163,
						"b": 175
					}
				},
				"cost": {
					"fg": {
						"r": 251,
						"g": 191,
						"b": 36
					}
				},
				"throughput": {
					"fg": {
						"r": 156,
						"g": 163,
						"b": 175
					}
				}
			}
		}
	},
	{
		"id": "catppuccin-latte",
		"label": "Catppuccin Latte",
		"group": "catppuccin",
		"groupLabel": "Catppuccin",
		"tone": "light",
		"tags": [
			"pastel",
			"warm",
			"gentle"
		],
		"detailTags": [
			"pastel",
			"warm",
			"gentle"
		],
		"description": "Soft Catppuccin palette with warm light tones.",
		"detailDescription": "Soft Catppuccin palette with warm bright tones.",
		"palette": {
			"text": {
				"r": 76,
				"g": 79,
				"b": 105
			},
			"dim": {
				"r": 156,
				"g": 160,
				"b": 176
			},
			"warn": {
				"r": 223,
				"g": 142,
				"b": 29
			},
			"error": {
				"r": 210,
				"g": 15,
				"b": 57
			},
			"separator": {
				"r": 156,
				"g": 160,
				"b": 176
			},
			"border": {
				"r": 204,
				"g": 208,
				"b": 218
			},
			"title": {
				"r": 30,
				"g": 102,
				"b": 245
			},
			"segments": {
				"git": {
					"fg": {
						"r": 64,
						"g": 160,
						"b": 43
					}
				},
				"model": {
					"fg": {
						"r": 114,
						"g": 135,
						"b": 253
					}
				},
				"context": {
					"fg": {
						"r": 23,
						"g": 146,
						"b": 153
					}
				},
				"tokens": {
					"fg": {
						"r": 140,
						"g": 143,
						"b": 161
					}
				},
				"cost": {
					"fg": {
						"r": 254,
						"g": 100,
						"b": 11
					}
				},
				"throughput": {
					"fg": {
						"r": 140,
						"g": 143,
						"b": 161
					}
				}
			}
		}
	},
	{
		"id": "catppuccin-mocha",
		"label": "Catppuccin Mocha",
		"group": "catppuccin",
		"groupLabel": "Catppuccin",
		"tone": "dark",
		"tags": [
			"pastel",
			"warm",
			"gentle"
		],
		"detailTags": [
			"pastel",
			"warm",
			"gentle"
		],
		"description": "Soft Catppuccin palette with warm dark tones.",
		"detailDescription": "Soft Catppuccin palette with warm dim tones.",
		"palette": {
			"text": {
				"r": 205,
				"g": 214,
				"b": 244
			},
			"dim": {
				"r": 108,
				"g": 112,
				"b": 134
			},
			"warn": {
				"r": 249,
				"g": 226,
				"b": 175
			},
			"error": {
				"r": 243,
				"g": 139,
				"b": 168
			},
			"separator": {
				"r": 108,
				"g": 112,
				"b": 134
			},
			"border": {
				"r": 49,
				"g": 50,
				"b": 68
			},
			"title": {
				"r": 137,
				"g": 180,
				"b": 250
			},
			"segments": {
				"git": {
					"fg": {
						"r": 166,
						"g": 227,
						"b": 161
					}
				},
				"model": {
					"fg": {
						"r": 180,
						"g": 190,
						"b": 254
					}
				},
				"context": {
					"fg": {
						"r": 148,
						"g": 226,
						"b": 213
					}
				},
				"tokens": {
					"fg": {
						"r": 127,
						"g": 132,
						"b": 156
					}
				},
				"cost": {
					"fg": {
						"r": 250,
						"g": 179,
						"b": 135
					}
				},
				"throughput": {
					"fg": {
						"r": 127,
						"g": 132,
						"b": 156
					}
				}
			}
		}
	},
	{
		"id": "nord",
		"label": "Nord",
		"group": "editor",
		"groupLabel": "Editor",
		"tone": "dark",
		"tags": [
			"cool",
			"arctic",
			"muted"
		],
		"detailTags": [
			"cool",
			"arctic",
			"muted"
		],
		"description": "Cool arctic palette with muted blues.",
		"detailDescription": "Cool arctic palette with muted blues.",
		"palette": {
			"text": {
				"r": 216,
				"g": 222,
				"b": 233
			},
			"dim": {
				"r": 76,
				"g": 86,
				"b": 106
			},
			"warn": {
				"r": 235,
				"g": 203,
				"b": 139
			},
			"error": {
				"r": 191,
				"g": 97,
				"b": 106
			},
			"separator": {
				"r": 76,
				"g": 86,
				"b": 106
			},
			"border": {
				"r": 94,
				"g": 129,
				"b": 172
			},
			"title": {
				"r": 136,
				"g": 192,
				"b": 208
			},
			"segments": {
				"git": {
					"fg": {
						"r": 163,
						"g": 190,
						"b": 140
					}
				},
				"model": {
					"fg": {
						"r": 129,
						"g": 161,
						"b": 193
					}
				},
				"context": {
					"fg": {
						"r": 143,
						"g": 188,
						"b": 187
					}
				},
				"tokens": {
					"fg": {
						"r": 76,
						"g": 86,
						"b": 106
					}
				},
				"cost": {
					"fg": {
						"r": 208,
						"g": 135,
						"b": 112
					}
				},
				"throughput": {
					"fg": {
						"r": 76,
						"g": 86,
						"b": 106
					}
				}
			}
		}
	},
	{
		"id": "tokyo-night",
		"label": "Tokyo Night",
		"group": "editor",
		"groupLabel": "Editor",
		"tone": "dark",
		"tags": [
			"cool",
			"vivid",
			"night"
		],
		"detailTags": [
			"cool",
			"vivid",
			"night"
		],
		"description": "Deep blue palette with vivid accents.",
		"detailDescription": "Deep blue palette with vivid accents.",
		"palette": {
			"text": {
				"r": 192,
				"g": 202,
				"b": 245
			},
			"dim": {
				"r": 86,
				"g": 95,
				"b": 137
			},
			"warn": {
				"r": 224,
				"g": 175,
				"b": 104
			},
			"error": {
				"r": 247,
				"g": 118,
				"b": 142
			},
			"separator": {
				"r": 59,
				"g": 66,
				"b": 97
			},
			"border": {
				"r": 122,
				"g": 162,
				"b": 247
			},
			"title": {
				"r": 125,
				"g": 207,
				"b": 255
			},
			"segments": {
				"git": {
					"fg": {
						"r": 158,
						"g": 206,
						"b": 106
					}
				},
				"model": {
					"fg": {
						"r": 187,
						"g": 154,
						"b": 247
					}
				},
				"context": {
					"fg": {
						"r": 125,
						"g": 207,
						"b": 255
					}
				},
				"tokens": {
					"fg": {
						"r": 86,
						"g": 95,
						"b": 137
					}
				},
				"cost": {
					"fg": {
						"r": 224,
						"g": 175,
						"b": 104
					}
				},
				"throughput": {
					"fg": {
						"r": 86,
						"g": 95,
						"b": 137
					}
				}
			}
		}
	},
	{
		"id": "gruvbox-dark",
		"label": "Gruvbox Dark",
		"group": "classic",
		"groupLabel": "Classics",
		"tone": "dark",
		"tags": [
			"warm",
			"retro",
			"earthy"
		],
		"detailTags": [
			"warm",
			"retro",
			"earthy"
		],
		"description": "Warm retro palette with earthy contrast.",
		"detailDescription": "Warm retro palette with earthy contrast.",
		"palette": {
			"text": {
				"r": 235,
				"g": 219,
				"b": 178
			},
			"dim": {
				"r": 146,
				"g": 131,
				"b": 116
			},
			"warn": {
				"r": 250,
				"g": 189,
				"b": 47
			},
			"error": {
				"r": 251,
				"g": 73,
				"b": 52
			},
			"separator": {
				"r": 80,
				"g": 73,
				"b": 69
			},
			"border": {
				"r": 104,
				"g": 157,
				"b": 106
			},
			"title": {
				"r": 184,
				"g": 187,
				"b": 38
			},
			"segments": {
				"git": {
					"fg": {
						"r": 184,
						"g": 187,
						"b": 38
					}
				},
				"model": {
					"fg": {
						"r": 131,
						"g": 165,
						"b": 152
					}
				},
				"context": {
					"fg": {
						"r": 142,
						"g": 192,
						"b": 124
					}
				},
				"tokens": {
					"fg": {
						"r": 146,
						"g": 131,
						"b": 116
					}
				},
				"cost": {
					"fg": {
						"r": 254,
						"g": 128,
						"b": 25
					}
				},
				"throughput": {
					"fg": {
						"r": 146,
						"g": 131,
						"b": 116
					}
				}
			}
		}
	},
	{
		"id": "solarized-dark",
		"label": "Solarized Dark",
		"group": "classic",
		"groupLabel": "Classics",
		"tone": "dark",
		"tags": [
			"classic",
			"low-contrast",
			"cyan"
		],
		"detailTags": [
			"classic",
			"low-contrast",
			"cyan"
		],
		"description": "Classic dark palette with restrained contrast.",
		"detailDescription": "Classic dim palette with restrained contrast.",
		"palette": {
			"text": {
				"r": 131,
				"g": 148,
				"b": 150
			},
			"dim": {
				"r": 88,
				"g": 110,
				"b": 117
			},
			"warn": {
				"r": 181,
				"g": 137,
				"b": 0
			},
			"error": {
				"r": 220,
				"g": 50,
				"b": 47
			},
			"separator": {
				"r": 88,
				"g": 110,
				"b": 117
			},
			"border": {
				"r": 38,
				"g": 139,
				"b": 210
			},
			"title": {
				"r": 42,
				"g": 161,
				"b": 152
			},
			"segments": {
				"git": {
					"fg": {
						"r": 133,
						"g": 153,
						"b": 0
					}
				},
				"model": {
					"fg": {
						"r": 38,
						"g": 139,
						"b": 210
					}
				},
				"context": {
					"fg": {
						"r": 42,
						"g": 161,
						"b": 152
					}
				},
				"tokens": {
					"fg": {
						"r": 88,
						"g": 110,
						"b": 117
					}
				},
				"cost": {
					"fg": {
						"r": 203,
						"g": 75,
						"b": 22
					}
				},
				"throughput": {
					"fg": {
						"r": 88,
						"g": 110,
						"b": 117
					}
				}
			}
		}
	},
	{
		"id": "rose-pine",
		"label": "Rosé Pine",
		"group": "editor",
		"groupLabel": "Editor",
		"tone": "dark",
		"tags": [
			"soft",
			"rose",
			"muted"
		],
		"detailTags": [
			"soft",
			"rose",
			"muted"
		],
		"description": "Muted rosy palette with gentle contrast.",
		"detailDescription": "Muted rosy palette with gentle contrast.",
		"palette": {
			"text": {
				"r": 224,
				"g": 222,
				"b": 244
			},
			"dim": {
				"r": 110,
				"g": 106,
				"b": 134
			},
			"warn": {
				"r": 246,
				"g": 193,
				"b": 119
			},
			"error": {
				"r": 235,
				"g": 111,
				"b": 146
			},
			"separator": {
				"r": 64,
				"g": 61,
				"b": 82
			},
			"border": {
				"r": 156,
				"g": 207,
				"b": 216
			},
			"title": {
				"r": 196,
				"g": 167,
				"b": 231
			},
			"segments": {
				"git": {
					"fg": {
						"r": 156,
						"g": 207,
						"b": 216
					}
				},
				"model": {
					"fg": {
						"r": 196,
						"g": 167,
						"b": 231
					}
				},
				"context": {
					"fg": {
						"r": 49,
						"g": 116,
						"b": 143
					}
				},
				"tokens": {
					"fg": {
						"r": 110,
						"g": 106,
						"b": 134
					}
				},
				"cost": {
					"fg": {
						"r": 246,
						"g": 193,
						"b": 119
					}
				},
				"throughput": {
					"fg": {
						"r": 110,
						"g": 106,
						"b": 134
					}
				}
			}
		}
	},
	{
		"id": "one-dark",
		"label": "One Dark",
		"group": "editor",
		"groupLabel": "Editor",
		"tone": "dark",
		"tags": [
			"editor",
			"balanced",
			"blue"
		],
		"detailTags": [
			"editor",
			"balanced",
			"blue"
		],
		"description": "Balanced dark editor palette with blue accents.",
		"detailDescription": "Balanced dim editor palette with blue accents.",
		"palette": {
			"text": {
				"r": 171,
				"g": 178,
				"b": 191
			},
			"dim": {
				"r": 92,
				"g": 99,
				"b": 112
			},
			"warn": {
				"r": 229,
				"g": 192,
				"b": 123
			},
			"error": {
				"r": 224,
				"g": 108,
				"b": 117
			},
			"separator": {
				"r": 75,
				"g": 82,
				"b": 99
			},
			"border": {
				"r": 97,
				"g": 175,
				"b": 239
			},
			"title": {
				"r": 86,
				"g": 182,
				"b": 194
			},
			"segments": {
				"git": {
					"fg": {
						"r": 152,
						"g": 195,
						"b": 121
					}
				},
				"model": {
					"fg": {
						"r": 97,
						"g": 175,
						"b": 239
					}
				},
				"context": {
					"fg": {
						"r": 86,
						"g": 182,
						"b": 194
					}
				},
				"tokens": {
					"fg": {
						"r": 92,
						"g": 99,
						"b": 112
					}
				},
				"cost": {
					"fg": {
						"r": 209,
						"g": 154,
						"b": 102
					}
				},
				"throughput": {
					"fg": {
						"r": 92,
						"g": 99,
						"b": 112
					}
				}
			}
		}
	},
	{
		"id": "one-light",
		"label": "One Light",
		"group": "editor",
		"groupLabel": "Editor",
		"tone": "light",
		"tags": [
			"editor",
			"balanced",
			"bright"
		],
		"detailTags": [
			"editor",
			"balanced",
			"bright"
		],
		"description": "Balanced bright editor palette with crisp blue accents.",
		"detailDescription": "Balanced bright editor palette with crisp blue accents.",
		"palette": {
			"text": {
				"r": 56,
				"g": 58,
				"b": 66
			},
			"dim": {
				"r": 160,
				"g": 161,
				"b": 167
			},
			"warn": {
				"r": 193,
				"g": 132,
				"b": 1
			},
			"error": {
				"r": 228,
				"g": 86,
				"b": 73
			},
			"separator": {
				"r": 160,
				"g": 161,
				"b": 167
			},
			"border": {
				"r": 64,
				"g": 120,
				"b": 242
			},
			"title": {
				"r": 1,
				"g": 132,
				"b": 143
			},
			"segments": {
				"git": {
					"fg": {
						"r": 80,
						"g": 161,
						"b": 79
					}
				},
				"model": {
					"fg": {
						"r": 64,
						"g": 120,
						"b": 242
					}
				},
				"context": {
					"fg": {
						"r": 1,
						"g": 132,
						"b": 143
					}
				},
				"tokens": {
					"fg": {
						"r": 160,
						"g": 161,
						"b": 167
					}
				},
				"cost": {
					"fg": {
						"r": 152,
						"g": 104,
						"b": 1
					}
				},
				"throughput": {
					"fg": {
						"r": 160,
						"g": 161,
						"b": 167
					}
				}
			}
		}
	},
	{
		"id": "solarized-light",
		"label": "Solarized Light",
		"group": "classic",
		"groupLabel": "Classics",
		"tone": "light",
		"tags": [
			"classic",
			"low-contrast",
			"cyan"
		],
		"detailTags": [
			"classic",
			"low-contrast",
			"cyan"
		],
		"description": "Classic bright palette with restrained contrast.",
		"detailDescription": "Classic bright palette with restrained contrast.",
		"palette": {
			"text": {
				"r": 101,
				"g": 123,
				"b": 131
			},
			"dim": {
				"r": 147,
				"g": 161,
				"b": 161
			},
			"warn": {
				"r": 181,
				"g": 137,
				"b": 0
			},
			"error": {
				"r": 220,
				"g": 50,
				"b": 47
			},
			"separator": {
				"r": 147,
				"g": 161,
				"b": 161
			},
			"border": {
				"r": 38,
				"g": 139,
				"b": 210
			},
			"title": {
				"r": 42,
				"g": 161,
				"b": 152
			},
			"segments": {
				"git": {
					"fg": {
						"r": 133,
						"g": 153,
						"b": 0
					}
				},
				"model": {
					"fg": {
						"r": 38,
						"g": 139,
						"b": 210
					}
				},
				"context": {
					"fg": {
						"r": 42,
						"g": 161,
						"b": 152
					}
				},
				"tokens": {
					"fg": {
						"r": 147,
						"g": 161,
						"b": 161
					}
				},
				"cost": {
					"fg": {
						"r": 203,
						"g": 75,
						"b": 22
					}
				},
				"throughput": {
					"fg": {
						"r": 147,
						"g": 161,
						"b": 161
					}
				}
			}
		}
	},
	{
		"id": "gruvbox-light",
		"label": "Gruvbox Light",
		"group": "classic",
		"groupLabel": "Classics",
		"tone": "light",
		"tags": [
			"warm",
			"retro",
			"parchment"
		],
		"detailTags": [
			"warm",
			"retro",
			"parchment"
		],
		"description": "Warm retro palette with parchment tones.",
		"detailDescription": "Warm retro palette with parchment tones.",
		"palette": {
			"text": {
				"r": 60,
				"g": 56,
				"b": 54
			},
			"dim": {
				"r": 146,
				"g": 131,
				"b": 116
			},
			"warn": {
				"r": 181,
				"g": 118,
				"b": 20
			},
			"error": {
				"r": 204,
				"g": 36,
				"b": 29
			},
			"separator": {
				"r": 168,
				"g": 153,
				"b": 132
			},
			"border": {
				"r": 104,
				"g": 157,
				"b": 106
			},
			"title": {
				"r": 121,
				"g": 116,
				"b": 14
			},
			"segments": {
				"git": {
					"fg": {
						"r": 121,
						"g": 116,
						"b": 14
					}
				},
				"model": {
					"fg": {
						"r": 69,
						"g": 133,
						"b": 136
					}
				},
				"context": {
					"fg": {
						"r": 104,
						"g": 157,
						"b": 106
					}
				},
				"tokens": {
					"fg": {
						"r": 146,
						"g": 131,
						"b": 116
					}
				},
				"cost": {
					"fg": {
						"r": 175,
						"g": 58,
						"b": 3
					}
				},
				"throughput": {
					"fg": {
						"r": 146,
						"g": 131,
						"b": 116
					}
				}
			}
		}
	},
	{
		"id": "rose-pine-dawn",
		"label": "Rosé Pine Dawn",
		"group": "editor",
		"groupLabel": "Editor",
		"tone": "light",
		"tags": [
			"soft",
			"rose",
			"dawn"
		],
		"detailTags": [
			"soft",
			"rose",
			"dawn"
		],
		"description": "Soft dawn palette with rosy accents.",
		"detailDescription": "Soft dawn palette with rosy accents.",
		"palette": {
			"text": {
				"r": 87,
				"g": 82,
				"b": 121
			},
			"dim": {
				"r": 121,
				"g": 117,
				"b": 147
			},
			"warn": {
				"r": 234,
				"g": 157,
				"b": 52
			},
			"error": {
				"r": 180,
				"g": 99,
				"b": 122
			},
			"separator": {
				"r": 144,
				"g": 140,
				"b": 170
			},
			"border": {
				"r": 86,
				"g": 148,
				"b": 159
			},
			"title": {
				"r": 144,
				"g": 122,
				"b": 169
			},
			"segments": {
				"git": {
					"fg": {
						"r": 86,
						"g": 148,
						"b": 159
					}
				},
				"model": {
					"fg": {
						"r": 144,
						"g": 122,
						"b": 169
					}
				},
				"context": {
					"fg": {
						"r": 40,
						"g": 105,
						"b": 131
					}
				},
				"tokens": {
					"fg": {
						"r": 121,
						"g": 117,
						"b": 147
					}
				},
				"cost": {
					"fg": {
						"r": 234,
						"g": 157,
						"b": 52
					}
				},
				"throughput": {
					"fg": {
						"r": 121,
						"g": 117,
						"b": 147
					}
				}
			}
		}
	},
	{
		"id": "catppuccin-frappe",
		"label": "Catppuccin Frappé",
		"group": "catppuccin",
		"groupLabel": "Catppuccin",
		"tone": "dark",
		"tags": [
			"pastel",
			"muted",
			"gentle"
		],
		"detailTags": [
			"pastel",
			"muted",
			"gentle"
		],
		"description": "Muted Catppuccin palette with cool dusk tones.",
		"detailDescription": "Muted Catppuccin palette with cool dusk tones.",
		"palette": {
			"text": {
				"r": 198,
				"g": 208,
				"b": 245
			},
			"dim": {
				"r": 115,
				"g": 121,
				"b": 148
			},
			"warn": {
				"r": 229,
				"g": 200,
				"b": 144
			},
			"error": {
				"r": 231,
				"g": 130,
				"b": 132
			},
			"separator": {
				"r": 98,
				"g": 104,
				"b": 128
			},
			"border": {
				"r": 65,
				"g": 69,
				"b": 89
			},
			"title": {
				"r": 140,
				"g": 170,
				"b": 238
			},
			"segments": {
				"git": {
					"fg": {
						"r": 166,
						"g": 209,
						"b": 137
					}
				},
				"model": {
					"fg": {
						"r": 186,
						"g": 187,
						"b": 241
					}
				},
				"context": {
					"fg": {
						"r": 129,
						"g": 200,
						"b": 190
					}
				},
				"tokens": {
					"fg": {
						"r": 131,
						"g": 139,
						"b": 167
					}
				},
				"cost": {
					"fg": {
						"r": 239,
						"g": 159,
						"b": 118
					}
				},
				"throughput": {
					"fg": {
						"r": 131,
						"g": 139,
						"b": 167
					}
				}
			}
		}
	},
	{
		"id": "catppuccin-macchiato",
		"label": "Catppuccin Macchiato",
		"group": "catppuccin",
		"groupLabel": "Catppuccin",
		"tone": "dark",
		"tags": [
			"pastel",
			"balanced",
			"gentle"
		],
		"detailTags": [
			"pastel",
			"balanced",
			"gentle"
		],
		"description": "Balanced Catppuccin palette with medium contrast.",
		"detailDescription": "Balanced Catppuccin palette with medium contrast.",
		"palette": {
			"text": {
				"r": 202,
				"g": 211,
				"b": 245
			},
			"dim": {
				"r": 110,
				"g": 115,
				"b": 141
			},
			"warn": {
				"r": 238,
				"g": 212,
				"b": 159
			},
			"error": {
				"r": 237,
				"g": 135,
				"b": 150
			},
			"separator": {
				"r": 91,
				"g": 96,
				"b": 120
			},
			"border": {
				"r": 54,
				"g": 58,
				"b": 79
			},
			"title": {
				"r": 138,
				"g": 173,
				"b": 244
			},
			"segments": {
				"git": {
					"fg": {
						"r": 166,
						"g": 218,
						"b": 149
					}
				},
				"model": {
					"fg": {
						"r": 183,
						"g": 189,
						"b": 248
					}
				},
				"context": {
					"fg": {
						"r": 139,
						"g": 213,
						"b": 202
					}
				},
				"tokens": {
					"fg": {
						"r": 128,
						"g": 135,
						"b": 162
					}
				},
				"cost": {
					"fg": {
						"r": 245,
						"g": 169,
						"b": 127
					}
				},
				"throughput": {
					"fg": {
						"r": 128,
						"g": 135,
						"b": 162
					}
				}
			}
		}
	},
	{
		"id": "kanagawa-wave",
		"label": "Kanagawa Wave",
		"group": "kanagawa",
		"groupLabel": "Japanese",
		"tone": "dark",
		"tags": [
			"ink",
			"wave",
			"muted"
		],
		"detailTags": [
			"ink",
			"wave",
			"muted"
		],
		"description": "Ink-toned palette with calm blue-green accents.",
		"detailDescription": "Ink-toned palette with calm blue-green accents.",
		"palette": {
			"text": {
				"r": 220,
				"g": 215,
				"b": 186
			},
			"dim": {
				"r": 114,
				"g": 124,
				"b": 122
			},
			"warn": {
				"r": 223,
				"g": 190,
				"b": 106
			},
			"error": {
				"r": 224,
				"g": 102,
				"b": 102
			},
			"separator": {
				"r": 84,
				"g": 84,
				"b": 109
			},
			"border": {
				"r": 126,
				"g": 156,
				"b": 216
			},
			"title": {
				"r": 127,
				"g": 180,
				"b": 202
			},
			"segments": {
				"git": {
					"fg": {
						"r": 152,
						"g": 187,
						"b": 108
					}
				},
				"model": {
					"fg": {
						"r": 126,
						"g": 156,
						"b": 216
					}
				},
				"context": {
					"fg": {
						"r": 127,
						"g": 180,
						"b": 202
					}
				},
				"tokens": {
					"fg": {
						"r": 114,
						"g": 124,
						"b": 122
					}
				},
				"cost": {
					"fg": {
						"r": 255,
						"g": 160,
						"b": 102
					}
				},
				"throughput": {
					"fg": {
						"r": 114,
						"g": 124,
						"b": 122
					}
				}
			}
		}
	},
	{
		"id": "kanagawa-lotus",
		"label": "Kanagawa Lotus",
		"group": "kanagawa",
		"groupLabel": "Japanese",
		"tone": "light",
		"tags": [
			"lotus",
			"warm",
			"calm"
		],
		"detailTags": [
			"lotus",
			"warm",
			"calm"
		],
		"description": "Warm paper-toned palette with calm ink accents.",
		"detailDescription": "Warm paper-toned palette with calm ink accents.",
		"palette": {
			"text": {
				"r": 84,
				"g": 74,
				"b": 67
			},
			"dim": {
				"r": 140,
				"g": 118,
				"b": 95
			},
			"warn": {
				"r": 179,
				"g": 124,
				"b": 37
			},
			"error": {
				"r": 196,
				"g": 88,
				"b": 80
			},
			"separator": {
				"r": 167,
				"g": 138,
				"b": 106
			},
			"border": {
				"r": 100,
				"g": 120,
				"b": 160
			},
			"title": {
				"r": 89,
				"g": 130,
				"b": 125
			},
			"segments": {
				"git": {
					"fg": {
						"r": 111,
						"g": 137,
						"b": 76
					}
				},
				"model": {
					"fg": {
						"r": 100,
						"g": 120,
						"b": 160
					}
				},
				"context": {
					"fg": {
						"r": 89,
						"g": 130,
						"b": 125
					}
				},
				"tokens": {
					"fg": {
						"r": 140,
						"g": 118,
						"b": 95
					}
				},
				"cost": {
					"fg": {
						"r": 179,
						"g": 124,
						"b": 37
					}
				},
				"throughput": {
					"fg": {
						"r": 140,
						"g": 118,
						"b": 95
					}
				}
			}
		}
	},
	{
		"id": "everforest-dark",
		"label": "Everforest Dark",
		"group": "everforest",
		"groupLabel": "Forest",
		"tone": "dark",
		"tags": [
			"forest",
			"warm",
			"muted"
		],
		"detailTags": [
			"forest",
			"warm",
			"muted"
		],
		"description": "Warm forest palette with softened contrast.",
		"detailDescription": "Warm forest palette with softened contrast.",
		"palette": {
			"text": {
				"r": 211,
				"g": 198,
				"b": 170
			},
			"dim": {
				"r": 133,
				"g": 146,
				"b": 137
			},
			"warn": {
				"r": 219,
				"g": 188,
				"b": 127
			},
			"error": {
				"r": 230,
				"g": 126,
				"b": 128
			},
			"separator": {
				"r": 79,
				"g": 88,
				"b": 83
			},
			"border": {
				"r": 131,
				"g": 192,
				"b": 146
			},
			"title": {
				"r": 127,
				"g": 187,
				"b": 179
			},
			"segments": {
				"git": {
					"fg": {
						"r": 167,
						"g": 192,
						"b": 128
					}
				},
				"model": {
					"fg": {
						"r": 127,
						"g": 187,
						"b": 179
					}
				},
				"context": {
					"fg": {
						"r": 131,
						"g": 192,
						"b": 146
					}
				},
				"tokens": {
					"fg": {
						"r": 133,
						"g": 146,
						"b": 137
					}
				},
				"cost": {
					"fg": {
						"r": 230,
						"g": 152,
						"b": 117
					}
				},
				"throughput": {
					"fg": {
						"r": 133,
						"g": 146,
						"b": 137
					}
				}
			}
		}
	},
	{
		"id": "everforest-light",
		"label": "Everforest Light",
		"group": "everforest",
		"groupLabel": "Forest",
		"tone": "light",
		"tags": [
			"forest",
			"warm",
			"soft"
		],
		"detailTags": [
			"forest",
			"warm",
			"soft"
		],
		"description": "Soft forest palette with warm daylight tones.",
		"detailDescription": "Soft forest palette with warm daylight tones.",
		"palette": {
			"text": {
				"r": 92,
				"g": 106,
				"b": 114
			},
			"dim": {
				"r": 147,
				"g": 153,
				"b": 128
			},
			"warn": {
				"r": 183,
				"g": 120,
				"b": 24
			},
			"error": {
				"r": 248,
				"g": 85,
				"b": 82
			},
			"separator": {
				"r": 167,
				"g": 192,
				"b": 128
			},
			"border": {
				"r": 53,
				"g": 167,
				"b": 124
			},
			"title": {
				"r": 58,
				"g": 148,
				"b": 134
			},
			"segments": {
				"git": {
					"fg": {
						"r": 141,
						"g": 161,
						"b": 1
					}
				},
				"model": {
					"fg": {
						"r": 58,
						"g": 148,
						"b": 134
					}
				},
				"context": {
					"fg": {
						"r": 53,
						"g": 167,
						"b": 124
					}
				},
				"tokens": {
					"fg": {
						"r": 147,
						"g": 153,
						"b": 128
					}
				},
				"cost": {
					"fg": {
						"r": 245,
						"g": 125,
						"b": 38
					}
				},
				"throughput": {
					"fg": {
						"r": 147,
						"g": 153,
						"b": 128
					}
				}
			}
		}
	},
	{
		"id": "high-contrast-dark",
		"label": "High Contrast Dark",
		"group": "accessibility",
		"groupLabel": "Accessible",
		"tone": "dark",
		"tags": [
			"contrast",
			"clear",
			"accessible"
		],
		"detailTags": [
			"contrast",
			"clear",
			"accessible"
		],
		"description": "High-contrast palette for maximum terminal clarity.",
		"detailDescription": "High-contrast palette for maximum terminal clarity.",
		"palette": {
			"text": {
				"r": 245,
				"g": 245,
				"b": 245
			},
			"dim": {
				"r": 170,
				"g": 170,
				"b": 170
			},
			"warn": {
				"r": 255,
				"g": 214,
				"b": 10
			},
			"error": {
				"r": 255,
				"g": 95,
				"b": 95
			},
			"separator": {
				"r": 136,
				"g": 136,
				"b": 136
			},
			"border": {
				"r": 0,
				"g": 255,
				"b": 180
			},
			"title": {
				"r": 0,
				"g": 220,
				"b": 255
			},
			"segments": {
				"git": {
					"fg": {
						"r": 0,
						"g": 255,
						"b": 180
					}
				},
				"model": {
					"fg": {
						"r": 130,
						"g": 170,
						"b": 255
					}
				},
				"context": {
					"fg": {
						"r": 0,
						"g": 220,
						"b": 255
					}
				},
				"tokens": {
					"fg": {
						"r": 200,
						"g": 200,
						"b": 200
					}
				},
				"cost": {
					"fg": {
						"r": 255,
						"g": 214,
						"b": 10
					}
				},
				"throughput": {
					"fg": {
						"r": 200,
						"g": 200,
						"b": 200
					}
				}
			}
		}
	},
	{
		"id": "high-contrast-light",
		"label": "High Contrast Light",
		"group": "accessibility",
		"groupLabel": "Accessible",
		"tone": "light",
		"tags": [
			"contrast",
			"clear",
			"accessible"
		],
		"detailTags": [
			"contrast",
			"clear",
			"accessible"
		],
		"description": "High-contrast bright palette for maximum terminal clarity.",
		"detailDescription": "High-contrast bright palette for maximum terminal clarity.",
		"palette": {
			"text": {
				"r": 0,
				"g": 0,
				"b": 0
			},
			"dim": {
				"r": 80,
				"g": 80,
				"b": 80
			},
			"warn": {
				"r": 153,
				"g": 92,
				"b": 0
			},
			"error": {
				"r": 204,
				"g": 0,
				"b": 0
			},
			"separator": {
				"r": 96,
				"g": 96,
				"b": 96
			},
			"border": {
				"r": 0,
				"g": 112,
				"b": 80
			},
			"title": {
				"r": 0,
				"g": 95,
				"b": 130
			},
			"segments": {
				"git": {
					"fg": {
						"r": 0,
						"g": 112,
						"b": 80
					}
				},
				"model": {
					"fg": {
						"r": 0,
						"g": 70,
						"b": 190
					}
				},
				"context": {
					"fg": {
						"r": 0,
						"g": 95,
						"b": 130
					}
				},
				"tokens": {
					"fg": {
						"r": 80,
						"g": 80,
						"b": 80
					}
				},
				"cost": {
					"fg": {
						"r": 153,
						"g": 92,
						"b": 0
					}
				},
				"throughput": {
					"fg": {
						"r": 80,
						"g": 80,
						"b": 80
					}
				}
			}
		}
	}
] as const satisfies readonly GlanceThemeCatalogEntry[];
