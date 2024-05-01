import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";

let persistedRefKeys = new Map<string, () => void>();

export function clearPersistedStates(keysToExclude?: string[]) {
  const promises: Promise<void>[] = [];
  for (const [key, callback] of persistedRefKeys.entries()) {
    if (Array.isArray(keysToExclude) && keysToExclude?.includes(key) === false)
      continue;
    promises.push(AsyncStorage.removeItem(key));
    callback?.();
  }

  return Promise.all(promises);
}

export default function usePersistRef<T>(key: string, defaultValue: T) {
  const stateRef = useRef<T>(defaultValue);
  persistedRefKeys.set(key, () => (stateRef.current = defaultValue));

  const newRef = useMemo(() => {
    return new Proxy(stateRef, {
      get: (target, prop) => {
        if (prop === "current") return target.current;
        return target[prop];
      },
      set: (target, prop, value) => {
        if (prop === "current") {
          target.current = value;
          setPersistedState(value);
          return true;
        }
        target[prop] = value;
        return true;
      },
    });
  }, []);

  function setPersistedState(value: T) {
    console.log("persisting", JSON.stringify(value));
    AsyncStorage.setItem(key, JSON.stringify(value)).then(() => {
      stateRef.current = value;
    });
  }

  async function retrieveFromPersistedState(): Promise<T> {
    const state = await AsyncStorage.getItem(key);
    if (state) return JSON.parse(state);
    return defaultValue;
  }

  useEffect(() => {
    AsyncStorage.getItem(key).then((value) => {
      if (value) stateRef.current = JSON.parse(value);
    });
  }, []);

  return [newRef, retrieveFromPersistedState] as const;
}