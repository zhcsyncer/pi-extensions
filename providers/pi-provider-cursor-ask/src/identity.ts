/**
 * Fork identity kept in one place so upstream syncs do not scatter provider
 * naming changes across the transport implementation.
 */
export const CURSOR_ASK_IDENTITY = {
  packageName: "pi-provider-cursor-ask",
  providerId: "cursor",
  nativeApi: "cursor-ask-native",
  apiSource: "pi-provider-cursor-ask",
  displayName: "Cursor Ask",
  commandName: "cursor",
  cacheEnvironmentVariable: "PI_CURSOR_ASK_CACHE_DIR",
  cacheDirectoryName: "pi-cursor-ask",
} as const;

export const CURSOR_ASK_LOGIN_COMMAND = `/login ${CURSOR_ASK_IDENTITY.providerId}`;
export const CURSOR_ASK_COMMAND = `/${CURSOR_ASK_IDENTITY.commandName}`;
export const CURSOR_ASK_DOCTOR_COMMAND = `${CURSOR_ASK_COMMAND} doctor`;
