import "react-native-url-polyfill/auto";
import { createClient, processLock, type SupportedStorage } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra ?? {};
const supabaseUrl = extra.supabaseUrl as string | undefined;
const supabasePublishableKey = extra.supabasePublishableKey as string | undefined;

const secureStorage: SupportedStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

const browserStorage: SupportedStorage = {
  getItem: async (key) => typeof window === "undefined" ? null : window.localStorage.getItem(key),
  setItem: async (key, value) => { if (typeof window !== "undefined") window.localStorage.setItem(key, value); },
  removeItem: async (key) => { if (typeof window !== "undefined") window.localStorage.removeItem(key); },
};

const authStorage = Platform.OS === "web" ? browserStorage : secureStorage;

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        storage: authStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: "pkce",
        lock: processLock,
      },
    })
  : null;
