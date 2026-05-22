import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import { AppErrorBoundary } from "./components/shared/AppErrorBoundary";
import { initializeI18n } from "./i18n";
import { ipc } from "./lib/ipc";
import { getBrowserLocaleFallback } from "./lib/locale";
import "./globals.css";
import keycloak from "./lib/keycloak";
import { listen } from "@tauri-apps/api/event";
import { getCurrent } from "@tauri-apps/plugin-deep-link";
import { isTauriRuntime } from "./lib/runtime";

const isTauri = isTauriRuntime();
const AUTH_TOKEN_KEYS = ["auth_token", "token", "accessToken"];

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return decodeURIComponent(
    atob(padded)
      .split("")
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  );
}

function parseJwtPayload(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(decodeBase64Url(payload));
  } catch (error) {
    console.warn("Could not parse launch token", error);
    return null;
  }
}

function isExpired(payload: Record<string, any> | null): boolean {
  if (!payload?.exp) return false;
  return Date.now() >= Number(payload.exp) * 1000;
}

function hydrateKeycloakSession(token: string): boolean {
  const payload = parseJwtPayload(token);
  if (isExpired(payload)) {
    AUTH_TOKEN_KEYS.forEach((key) => localStorage.removeItem(key));
    return false;
  }

  AUTH_TOKEN_KEYS.forEach((key) => localStorage.setItem(key, token));

  if (payload) {
    localStorage.setItem(
      "user",
      JSON.stringify({
        fullName: payload.name || "",
        username: payload.preferred_username || "",
        email: payload.email || "",
      })
    );
  }

  const keycloakSession = keycloak as any;
  keycloakSession.authenticated = true;
  keycloakSession.token = token;
  keycloakSession.tokenParsed = payload || undefined;

  return true;
}

function persistLaunchAuth(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!["bharattech:", "bharattech-coder:"].includes(url.protocol)) {
      return false;
    }

    const token =
      url.searchParams.get("token") ||
      url.searchParams.get("access_token") ||
      url.searchParams.get("auth_token");

    return token ? hydrateKeycloakSession(token) : false;
  } catch (error) {
    console.warn("Could not process BharatTech launch URL", error);
    return false;
  }
}

function extractDeepLinkUrls(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.map(String);
  }
  if (typeof payload === "string") {
    return [payload];
  }
  return [];
}

async function bootstrap() {
  try {
    let locale = getBrowserLocaleFallback();

    if (isTauri) {
      try {
        const appLocale = await ipc.getAppLocale();
        if (appLocale) {
          locale = appLocale;
        }
      } catch {
        console.log("Failed to get locale from Tauri");
      }
    } else {
      console.log("Running in browser mode");
    }

    await initializeI18n(locale);

    if (isTauri) {
      try {
        const urls = await getCurrent();
        urls?.forEach((url) => persistLaunchAuth(String(url)));
      } catch (error) {
        console.warn("Could not read initial BharatTech launch URL", error);
      }

      void listen("deep-link://new-url", (event) => {
        const handled = extractDeepLinkUrls(event.payload).some(persistLaunchAuth);
        if (handled) {
          console.log("BharatTech launch session updated");
        }
      });
    }

    const savedToken = AUTH_TOKEN_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
    let authenticated = false;

    if (savedToken) {
      authenticated = hydrateKeycloakSession(savedToken);
    }

    if (!authenticated) {
      authenticated = await keycloak.init({
        onLoad: "login-required",
        checkLoginIframe: false,
      });
    }

    if (!authenticated) {
      console.error("Not authenticated");
      return;
    }

    createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    console.error("BOOTSTRAP ERROR:", error);
  }
}

void bootstrap();
