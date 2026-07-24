import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { defaultConfig } from "../config.js";
import { PALETTES, fg } from "../palette.js";
import { createPiRenderStyleContext, readPiUiTheme, resolveRuntimeRenderStyleContext } from "../render-style-context.js";
import { resolveBuiltInGlanceStyles, resolveGlanceRenderStyles, resolvePiThemeStyles, type PiThemeColorToken, type PiThemeLike } from "../theme-adapter.js";
import { selectGlanceTheme } from "../theme-selection.js";
import { readPiAmbientTone } from "../theme-tone.js";
import { GLANCE_THEME_CATALOG } from "../theme-catalog.js";
import { GLANCE_THEMES, GLANCE_THEME_IDS, isGlanceThemeName, themeLabel } from "../themes.js";
import type { GlancePalette, Rgb, SegmentId } from "../types.js";

const EXPECTED_THEMES = [
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
		"detailDescription": "Bright neutral palette for well-lit terminals."
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
		"detailDescription": "Neutral dim palette for dim terminals."
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
		"detailDescription": "Soft Catppuccin palette with warm bright tones."
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
		"detailDescription": "Soft Catppuccin palette with warm dim tones."
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
		"detailDescription": "Cool arctic palette with muted blues."
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
		"detailDescription": "Deep blue palette with vivid accents."
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
		"detailDescription": "Warm retro palette with earthy contrast."
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
		"detailDescription": "Classic dim palette with restrained contrast."
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
		"detailDescription": "Muted rosy palette with gentle contrast."
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
		"detailDescription": "Balanced dim editor palette with blue accents."
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
		"detailDescription": "Balanced bright editor palette with crisp blue accents."
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
		"detailDescription": "Classic bright palette with restrained contrast."
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
		"detailDescription": "Warm retro palette with parchment tones."
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
		"detailDescription": "Soft dawn palette with rosy accents."
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
		"detailDescription": "Muted Catppuccin palette with cool dusk tones."
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
		"detailDescription": "Balanced Catppuccin palette with medium contrast."
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
		"detailDescription": "Ink-toned palette with calm blue-green accents."
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
		"detailDescription": "Warm paper-toned palette with calm ink accents."
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
		"detailDescription": "Warm forest palette with softened contrast."
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
		"detailDescription": "Soft forest palette with warm daylight tones."
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
		"detailDescription": "High-contrast palette for maximum terminal clarity."
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
		"detailDescription": "High-contrast bright palette for maximum terminal clarity."
	}
] as const;

const EXPECTED_THEME_IDS = [
	"light",
	"dark",
	"catppuccin-latte",
	"catppuccin-mocha",
	"nord",
	"tokyo-night",
	"gruvbox-dark",
	"solarized-dark",
	"rose-pine",
	"one-dark",
	"one-light",
	"solarized-light",
	"gruvbox-light",
	"rose-pine-dawn",
	"catppuccin-frappe",
	"catppuccin-macchiato",
	"kanagawa-wave",
	"kanagawa-lotus",
	"everforest-dark",
	"everforest-light",
	"high-contrast-dark",
	"high-contrast-light"
] as const;

const EXPECTED_PALETTES = {
	"light": {
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
	},
	"dark": {
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
	},
	"catppuccin-latte": {
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
	},
	"catppuccin-mocha": {
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
	},
	"nord": {
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
	},
	"tokyo-night": {
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
	},
	"gruvbox-dark": {
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
	},
	"solarized-dark": {
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
	},
	"rose-pine": {
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
	},
	"one-dark": {
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
	},
	"one-light": {
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
	},
	"solarized-light": {
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
	},
	"gruvbox-light": {
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
	},
	"rose-pine-dawn": {
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
	},
	"catppuccin-frappe": {
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
	},
	"catppuccin-macchiato": {
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
	},
	"kanagawa-wave": {
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
	},
	"kanagawa-lotus": {
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
	},
	"everforest-dark": {
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
	},
	"everforest-light": {
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
	},
	"high-contrast-dark": {
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
	},
	"high-contrast-light": {
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
} as const;

const PALETTE_KEYS = ["text", "dim", "warn", "error", "separator", "border", "title", "segments"] as const;
const STYLE_ROLE_KEYS = ["text", "dim", "warn", "error", "separator", "border", "title"] as const;
const SEGMENT_IDS = ["git", "model", "context", "tokens", "cost", "throughput"] as const satisfies readonly SegmentId[];
const FORBIDDEN_THEME_CATALOG_LOCAL_IMPORTS = new Set([
	"./palette",
	"./themes",
	"./settings-catalog",
	"./pane",
	"./pane-model",
	"./renderer",
	"./editor",
	"./status-line",
	"./surface-layout",
	"./runtime",
	"./runtime-policy",
	"./runtime-snapshot",
	"./config",
	"./config-options",
]);
const FORBIDDEN_THEME_CATALOG_IMPORT_PREFIXES = ["@earendil-works/pi-"] as const;
const EXPECTED_THEME_GROUP_LABELS: Record<string, string> = {
	core: "Core",
	catppuccin: "Catppuccin",
	classic: "Classics",
	editor: "Editor",
	kanagawa: "Japanese",
	everforest: "Forest",
	accessibility: "Accessible",
};
const FORBIDDEN_THEMES_SOURCE_SNIPPETS = [
	"id: \"light\"",
	"label: \"Light\"",
	"description: \"Bright neutral palette for well-lit terminals.\"",
	"id: \"high-contrast-light\"",
	"label: \"High Contrast Light\"",
	"description: \"High-contrast bright palette for maximum terminal clarity.\"",
] as const;
const FORBIDDEN_PALETTE_SOURCE_SNIPPETS = [
	"export const PALETTES: Record<GlanceThemeName, GlancePalette> = {",
	"light: {\n\t\ttext: { r: 15, g: 23, b: 42 }",
	"\"catppuccin-latte\": {\n\t\ttext: { r: 76, g: 79, b: 105 }",
	"\"high-contrast-light\": {\n\t\ttext: { r: 0, g: 0, b: 0 }",
] as const;

function moduleSpecifiers(source: string): string[] {
	return [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)].map((match) => match[1] ?? match[2]!);
}

function normalizeLocalImport(specifier: string): string {
	return specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
}

function assertSourceIncludes(path: string, source: string, snippet: string): void {
	assert.equal(source.includes(snippet), true, `${path} should contain source snippet ${snippet}`);
}

function assertSourceExcludes(path: string, source: string, snippet: string): void {
	assert.equal(source.includes(snippet), false, `${path} should not contain source snippet ${snippet}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesRawThemeId(text: string, themeId: string): boolean {
	return new RegExp(`\\b${escapeRegExp(themeId)}\\b`).test(text);
}

const themeCatalogSource = await readFile("theme-catalog.ts", "utf8");
const themesSource = await readFile("themes.ts", "utf8");
const paletteSource = await readFile("palette.ts", "utf8");

for (const specifier of moduleSpecifiers(themeCatalogSource)) {
	assert.equal(FORBIDDEN_THEME_CATALOG_LOCAL_IMPORTS.has(normalizeLocalImport(specifier)), false, `theme-catalog.ts should not import ${specifier}`);
	for (const prefix of FORBIDDEN_THEME_CATALOG_IMPORT_PREFIXES) {
		assert.equal(specifier.startsWith(prefix), false, `theme-catalog.ts should not import ${specifier}`);
	}
}

assertSourceIncludes("themes.ts", themesSource, "import { GLANCE_THEME_CATALOG } from \"./theme-catalog.js\";");
for (const snippet of FORBIDDEN_THEMES_SOURCE_SNIPPETS) {
	assertSourceExcludes("themes.ts", themesSource, snippet);
}

assertSourceIncludes("palette.ts", paletteSource, "import { GLANCE_THEME_CATALOG } from \"./theme-catalog.js\";");
assertSourceIncludes("palette.ts", paletteSource, "GLANCE_THEME_CATALOG.map((theme) => [theme.id, theme.palette])");
for (const snippet of FORBIDDEN_PALETTE_SOURCE_SNIPPETS) {
	assertSourceExcludes("palette.ts", paletteSource, snippet);
}

const catalogMetadata = GLANCE_THEME_CATALOG.map(({ palette, ...metadata }) => metadata);
const catalogPalettes = Object.fromEntries(GLANCE_THEME_CATALOG.map((entry) => [entry.id, entry.palette]));

assert.equal(GLANCE_THEMES.length, 22, "theme metadata should keep the curated 22-theme collection");
assert.deepEqual(GLANCE_THEMES, EXPECTED_THEMES, "theme metadata should preserve exact current id/label/group/tone/tags/detail display snapshot");
assert.deepEqual(GLANCE_THEME_IDS, EXPECTED_THEME_IDS, "theme id helper should preserve exact GLANCE_THEMES order");
assert.deepEqual(Object.keys(PALETTES), EXPECTED_THEME_IDS, "palette object key order should exactly match GLANCE_THEME_IDS");
assert.deepEqual(PALETTES, EXPECTED_PALETTES, "palette RGB snapshot should preserve exact current theme colors");
assert.deepEqual(GLANCE_THEME_CATALOG.map((entry) => entry.id), GLANCE_THEME_IDS, "unified theme catalog should preserve exact GLANCE_THEME_IDS order");
assert.deepEqual(catalogMetadata, GLANCE_THEMES, "unified theme catalog metadata projection should match active GLANCE_THEMES export");
assert.deepEqual(catalogPalettes, PALETTES, "unified theme catalog palette projection should match active PALETTES export");

const themeIds = GLANCE_THEMES.map((theme) => theme.id);
const themeLabels = GLANCE_THEMES.map((theme) => theme.label);
assert.equal(new Set(themeIds).size, themeIds.length, "theme ids should be unique");
assert.equal(new Set(themeLabels).size, themeLabels.length, "theme labels should be unique");

for (const { id, label, group, groupLabel, tone, tags, detailTags, description, detailDescription } of GLANCE_THEMES) {
	assert.ok(label.trim(), `${id} should have a non-empty user-facing label`);
	assert.ok(group.trim(), `${id} should have a non-empty metadata group`);
	assert.equal(groupLabel, EXPECTED_THEME_GROUP_LABELS[group], `${id} browser group label should come from catalog display copy`);
	assert.ok(tone === "light" || tone === "dark", `${id} should declare a stable light/dark tone`);
	assert.ok(tags.length > 0, `${id} should have at least one metadata tag`);
	assert.equal(new Set(tags).size, tags.length, `${id} metadata tags should be unique`);
	for (const tag of tags) {
		assert.equal(tag, tag.trim(), `${id} metadata tag should be trimmed`);
		assert.match(tag, /^[a-z0-9-]+$/, `${id} metadata tag should be lowercase kebab text`);
	}
	assert.ok(detailTags.length > 0, `${id} should have browser detail tags`);
	assert.equal(new Set(detailTags).size, detailTags.length, `${id} browser detail tags should be unique`);
	for (const tag of detailTags) {
		assert.equal(tag, tag.trim(), `${id} browser detail tag should be trimmed`);
		assert.equal(themeIds.includes(tag as never), false, `${id} browser detail tag should not expose raw theme id ${tag}`);
	}
	assert.ok(description.trim(), `${id} should have a non-empty metadata description`);
	assert.ok(detailDescription.trim(), `${id} should have a non-empty browser detail description`);
	for (const themeId of themeIds) {
		assert.equal(includesRawThemeId(detailDescription, themeId), false, `${id} browser detail description should not expose raw theme id ${themeId}`);
	}
	assert.ok(PALETTES[id], `${id} palette should exist`);
	assert.equal(themeLabel(id), label, `${id} label should come from shared metadata`);
	assert.equal(isGlanceThemeName(id), true, `${id} should validate as a theme name`);
}

const themesById = new Map(GLANCE_THEMES.map((theme) => [theme.id, theme]));
assert.deepEqual(themesById.get("dark")?.detailTags, ["default", "neutral"], "dark browser detail tags should keep raw id suppression");
assert.equal(themesById.get("dark")?.detailDescription, "Neutral dim palette for dim terminals.", "dark browser detail should keep low-light/friendly text behavior");
assert.equal(themesById.get("catppuccin-latte")?.detailDescription, "Soft Catppuccin palette with warm bright tones.", "light raw id should be friendly in browser detail copy");
assert.equal(themesById.get("kanagawa-wave")?.groupLabel, "Japanese", "kanagawa browser group label should stay friendly");
assert.equal(themesById.get("everforest-dark")?.groupLabel, "Forest", "everforest browser group label should stay friendly");
assert.equal(themesById.get("high-contrast-dark")?.groupLabel, "Accessible", "accessibility browser group label should stay friendly");

assert.equal(themeLabel("dracula" as never), "dracula", "unknown theme label should fall back to the provided id");
assert.equal(isGlanceThemeName("catppuccin-macchiato"), true, "curated Catppuccin Macchiato theme should validate");
assert.equal(isGlanceThemeName("high-contrast-light"), true, "new counterpart High Contrast Light theme should validate");
assert.equal(isGlanceThemeName("one-light"), true, "new counterpart One Light theme should validate");
assert.equal(isGlanceThemeName("kanagawa-lotus"), true, "new counterpart Kanagawa Lotus theme should validate");
assert.equal(isGlanceThemeName("everforest-light"), true, "new counterpart Everforest Light theme should validate");
assert.equal(isGlanceThemeName("dracula"), false, "unknown theme should not validate");

const selectedThemePair = { light: "one-light", dark: "tokyo-night" } as const;
assert.equal(selectGlanceTheme(selectedThemePair, "light"), "one-light", "theme selection should return the light slot for light ambient tone");
assert.equal(selectGlanceTheme(selectedThemePair, "dark"), "tokyo-night", "theme selection should return the dark slot for dark ambient tone");
assert.equal(selectGlanceTheme(selectedThemePair, "unknown"), "one-light", "theme selection should fall back to the light slot for unknown ambient tone");
assert.equal(resolveGlanceRenderStyles(selectedThemePair, { ambientTone: "light" }).themeId, "one-light", "render style resolver should use the light slot for ambient light");
assert.equal(resolveGlanceRenderStyles(selectedThemePair, { ambientTone: "dark" }).themeId, "tokyo-night", "render style resolver should use the dark slot for ambient dark");
assert.equal(resolveGlanceRenderStyles(selectedThemePair, { ambientTone: "unknown" }).themeId, "one-light", "render style resolver should use the light slot for ambient unknown");
assert.equal(resolveGlanceRenderStyles(selectedThemePair).themeId, "one-light", "render style resolver should default missing ambient tone to the light slot");
assert.equal(resolveGlanceRenderStyles(selectedThemePair, { getAmbientTone: () => "dark" }).themeId, "tokyo-night", "render style resolver should use lazy getAmbientTone when no static tone is provided");
assert.equal(
	resolveGlanceRenderStyles(selectedThemePair, { ambientTone: "light", getAmbientTone: () => "dark" }).themeId,
	"one-light",
	"render style resolver should prefer static ambientTone over getAmbientTone",
);
const explicitStyleOverride = resolveBuiltInGlanceStyles("dark");
assert.equal(
	resolveGlanceRenderStyles(selectedThemePair, { styles: explicitStyleOverride, ambientTone: "light", getAmbientTone: () => "dark" }),
	explicitStyleOverride,
	"render style resolver should return an explicit styles override without applying ambient tone selection",
);

assert.equal(readPiAmbientTone({ theme: { name: "light" } }), "light", "ambient tone reader should map exact public Pi theme name light to light tone");
assert.equal(readPiAmbientTone({ theme: { name: "dark" } }), "dark", "ambient tone reader should map exact public Pi theme name dark to dark tone");
for (const host of [undefined, {}, { theme: undefined }, { theme: {} }, { theme: { name: undefined } }] as const) {
	assert.equal(readPiAmbientTone(host), "unknown", "ambient tone reader should return unknown for missing host/theme/name");
}
for (const name of ["my-dark-theme", "dark-plus", "catppuccin-latte", "high-contrast-light", "Light", "DARK", " dark "] as const) {
	assert.equal(readPiAmbientTone({ theme: { name } }), "unknown", `${name} should not be classified by substring/case/trim heuristics`);
}
const colorModeOnlyHost = { theme: { name: "catppuccin-latte", getColorMode: () => "dark" } };
assert.equal(readPiAmbientTone(colorModeOnlyHost), "unknown", "ambient tone reader should ignore getColorMode because it is color depth, not tone");
assert.equal(selectGlanceTheme(selectedThemePair, readPiAmbientTone(colorModeOnlyHost)), "one-light", "unknown ambient tone from reader should select the light slot");
assert.equal(selectGlanceTheme(selectedThemePair, readPiAmbientTone({ theme: { name: "dark" } })), "tokyo-night", "dark ambient tone from reader should select the dark slot");

function assertRgb(themeId: string, path: string, color: Rgb): void {
	for (const channel of ["r", "g", "b"] as const) {
		const value = color[channel];
		assert.ok(Number.isFinite(value), `${themeId}.${path}.${channel} should be finite`);
		assert.ok(Number.isInteger(value), `${themeId}.${path}.${channel} should be an integer`);
		assert.ok(value >= 0 && value <= 255, `${themeId}.${path}.${channel} should be in [0,255]`);
	}
}

function assertPalette(themeId: (typeof GLANCE_THEME_IDS)[number], theme: GlancePalette): void {
	assert.deepEqual(Object.keys(theme), PALETTE_KEYS, `${themeId} should preserve exact top-level palette key order`);
	assert.deepEqual(Object.keys(theme.segments), SEGMENT_IDS, `${themeId} should preserve exact segment color key order`);

	for (const key of ["text", "dim", "warn", "error", "separator", "border", "title"] as const) {
		assertRgb(themeId, key, theme[key]);
	}

	for (const segment of SEGMENT_IDS) {
		assert.ok(theme.segments[segment], `${themeId} should define ${segment} segment color`);
		assertRgb(themeId, `segments.${segment}.fg`, theme.segments[segment].fg);
	}
}

const styleCacheKeys = new Set<string>();
for (const themeId of GLANCE_THEME_IDS) {
	const palette: GlancePalette = PALETTES[themeId];
	assertPalette(themeId, palette);

	const styles = resolveBuiltInGlanceStyles(themeId);
	const secondStyles = resolveBuiltInGlanceStyles(themeId);
	assert.equal(styles.source, "glance", `${themeId} resolved style source should identify built-in pi-glance palette`);
	assert.equal(styles.themeId, themeId, `${themeId} resolved style themeId should preserve selected built-in theme`);
	assert.equal(styles.label, themeLabel(themeId), `${themeId} resolved style label should match theme metadata`);
	assert.equal(styles.cacheKey, `glance:${themeId}`, `${themeId} resolved style cacheKey should be stable and theme-specific`);
	assert.equal(secondStyles.cacheKey, styles.cacheKey, `${themeId} resolved style cacheKey should be stable across calls`);
	styleCacheKeys.add(styles.cacheKey);

	for (const role of STYLE_ROLE_KEYS) {
		const text = `${themeId}:${role}:sample`;
		assert.equal(styles[role](text), fg(palette[role], text), `${themeId}.${role} style should preserve current fg(PALETTES[theme].${role}, text) ANSI output`);
	}
	for (const segment of SEGMENT_IDS) {
		const text = `${themeId}:${segment}:segment`;
		assert.equal(
			styles.segments[segment].fg(text),
			fg(palette.segments[segment].fg, text),
			`${themeId}.segments.${segment}.fg style should preserve current palette segment ANSI output`,
		);
	}
}
assert.equal(styleCacheKeys.size, GLANCE_THEME_IDS.length, "resolved style cache keys should be unique across all built-in themes");

const PI_TOKEN_COLORS: Record<PiThemeColorToken, Rgb> = {
	accent: { r: 10, g: 20, b: 30 },
	border: { r: 11, g: 21, b: 31 },
	borderAccent: { r: 12, g: 22, b: 32 },
	borderMuted: { r: 13, g: 23, b: 33 },
	success: { r: 14, g: 24, b: 34 },
	error: { r: 15, g: 25, b: 35 },
	warning: { r: 16, g: 26, b: 36 },
	muted: { r: 17, g: 27, b: 37 },
	dim: { r: 18, g: 28, b: 38 },
	text: { r: 19, g: 29, b: 39 },
};

function fakePiTheme(colors: Partial<Record<PiThemeColorToken, Rgb>>, name = "fake-pi", mode = "truecolor", sourcePath = "/tmp/fake-pi.json"): PiThemeLike {
	return {
		name,
		sourcePath,
		getColorMode: () => mode,
		fg: (token, text) => {
			const color = colors[token];
			if (!color) throw new Error(`missing fake pi theme token ${token}`);
			return fg(color, text);
		},
	};
}

{
	const piTheme = fakePiTheme(PI_TOKEN_COLORS);
	const styles = resolvePiThemeStyles(piTheme);
	const secondStyles = resolvePiThemeStyles(piTheme);
	assert.equal(styles.source, "pi", "Pi theme adapter source should identify future Pi theme styles");
	assert.equal(styles.themeId, "fake-pi", "Pi theme adapter should use public theme name as themeId");
	assert.equal(styles.label, "fake-pi", "Pi theme adapter should default label to public theme name");
	assert.equal(styles.cacheKey, secondStyles.cacheKey, "Pi theme cacheKey should be deterministic across calls");
	assert.equal(styles.cacheKey, 'pi:["fake-pi","truecolor","/tmp/fake-pi.json"]', "Pi theme cacheKey should include name, color mode, and source path");
	assert.equal(resolvePiThemeStyles(piTheme, { cacheKey: "manual", label: "Manual Pi" }).cacheKey, "pi:manual", "Pi theme adapter should accept explicit cacheKey override for future host identity");
	assert.equal(resolvePiThemeStyles(piTheme, { cacheKey: "manual", label: "Manual Pi" }).label, "Manual Pi", "Pi theme adapter should accept explicit label override");

	assert.equal(styles.text("txt"), fg(PI_TOKEN_COLORS.text, "txt"), "Pi text should map to text token");
	assert.equal(styles.dim("dim"), fg(PI_TOKEN_COLORS.dim, "dim"), "Pi dim should map to dim token");
	assert.equal(styles.warn("warn"), fg(PI_TOKEN_COLORS.warning, "warn"), "Pi warn should map to warning token");
	assert.equal(styles.error("error"), fg(PI_TOKEN_COLORS.error, "error"), "Pi error should map to error token");
	assert.equal(styles.separator(" · "), fg(PI_TOKEN_COLORS.muted, " · "), "Pi separator should map to muted token");
	assert.equal(styles.border("│"), fg(PI_TOKEN_COLORS.border, "│"), "Pi border should map to border token");
	assert.equal(styles.title("title"), fg(PI_TOKEN_COLORS.accent, "title"), "Pi title should map to accent token");
	assert.equal(styles.segments.git.fg("git"), fg(PI_TOKEN_COLORS.success, "git"), "Pi git segment should map to success token");
	assert.equal(styles.segments.model.fg("model"), fg(PI_TOKEN_COLORS.text, "model"), "Pi model segment should map to text token");
	assert.equal(styles.segments.context.fg("ctx"), fg(PI_TOKEN_COLORS.accent, "ctx"), "Pi context segment should map to accent token");
	assert.equal(styles.segments.tokens.fg("tok"), fg(PI_TOKEN_COLORS.muted, "tok"), "Pi tokens segment should map to muted token");
	assert.equal(styles.segments.cost.fg("cost"), fg(PI_TOKEN_COLORS.warning, "cost"), "Pi cost segment should map to warning token");
	assert.equal(styles.segments.throughput.fg("spd"), fg(PI_TOKEN_COLORS.muted, "spd"), "Pi throughput segment should map to muted token");

	assert.equal(readPiUiTheme({ theme: piTheme }), piTheme, "runtime style provider seam should read the public current UI theme shape");
	assert.equal(readPiUiTheme(undefined), undefined, "runtime style provider seam should tolerate missing UI host in tests/non-TUI harnesses");
	assert.equal(createPiRenderStyleContext(undefined), undefined, "Pi render style context helper should stay empty when no current Pi theme is available");
	const directContext = createPiRenderStyleContext(piTheme);
	assert.equal(directContext?.styles?.source, "pi", "Pi render style context helper should convert a current Pi theme into injectable styles");
	assert.equal(directContext?.styles?.cacheKey, styles.cacheKey, "Pi render style context helper should reuse adapter cache identity");
	assert.equal(resolveRuntimeRenderStyleContext(defaultConfig(), { piTheme }), undefined, "runtime render style context should remain inactive for current configs without a future explicit enable condition");
	const futureContext = resolveRuntimeRenderStyleContext(defaultConfig(), { piTheme, enablePiThemeStyles: true });
	assert.equal(futureContext?.styles?.source, "pi", "runtime render style context has a future explicit enable seam for Pi theme styles");
	assert.equal(futureContext?.styles?.text("txt"), fg(PI_TOKEN_COLORS.text, "txt"), "future enabled runtime context should carry Pi token styling when explicitly requested");
}

{
	const fallbackTheme = fakePiTheme({
		accent: PI_TOKEN_COLORS.accent,
		muted: PI_TOKEN_COLORS.muted,
		text: PI_TOKEN_COLORS.text,
	}, "fallback-pi", "256color", "");
	const styles = resolvePiThemeStyles(fallbackTheme);
	assert.equal(styles.cacheKey, 'pi:["fallback-pi","256color",""]', "Pi theme fallback cacheKey should stay deterministic without sourcePath");
	assert.equal(styles.dim("dim"), fg(PI_TOKEN_COLORS.muted, "dim"), "missing Pi dim should fall back to muted");
	assert.equal(styles.warn("warn"), fg(PI_TOKEN_COLORS.accent, "warn"), "missing Pi warning should fall back to accent");
	assert.equal(styles.error("error"), fg(PI_TOKEN_COLORS.text, "error"), "missing Pi error/warning should fall back to text");
	assert.equal(styles.separator("sep"), fg(PI_TOKEN_COLORS.muted, "sep"), "missing Pi separator-specific tokens should fall back to muted");
	assert.equal(styles.border("border"), fg(PI_TOKEN_COLORS.muted, "border"), "missing Pi border tokens should fall back to muted");
	assert.equal(styles.title("title"), fg(PI_TOKEN_COLORS.accent, "title"), "missing Pi title accent alternatives should use accent");
	assert.equal(styles.segments.git.fg("git"), fg(PI_TOKEN_COLORS.accent, "git"), "missing Pi success should fall back git to accent");
	assert.equal(styles.segments.cost.fg("cost"), fg(PI_TOKEN_COLORS.accent, "cost"), "missing Pi warning should fall back cost to accent");
	assert.equal(styles.segments.tokens.fg("tok"), fg(PI_TOKEN_COLORS.muted, "tok"), "missing Pi token-specific colors should fall back tokens to muted");
}

console.log("✓ theme config checks passed");
