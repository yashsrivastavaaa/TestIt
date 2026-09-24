"use client";

import axios from "axios";
import { useUser as useClerkUser } from "@clerk/nextjs";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@/db/schema";

type UserContextValue = {
  user: (Omit<User, "createdAt"> & { createdAt: string }) | null;
  isLoading: boolean;
  error: string | null;
};

const UserContext = createContext<UserContextValue | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useClerkUser();
  const [user, setUser] = useState<UserContextValue["user"]>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!isLoaded) return () => { active = false; };

    if (!isSignedIn) {
      setUser(null);
      setError(null);
      setIsLoading(false);
      return () => { active = false; };
    }

    setIsLoading(true);
    setError(null);

    axios
      .post<{ user: UserContextValue["user"] }>("/api/users", {})
      .then(({ data }) => {
        if (active) setUser(data.user);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        setUser(null);
        setError(
          axios.isAxiosError(requestError)
            ? requestError.response?.data?.error ?? requestError.message
            : "Unable to load your user profile."
        );
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => { active = false; };
  }, [isLoaded, isSignedIn]);

  return (
    <UserContext.Provider value={{ user, isLoading, error }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUserContext() {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error("useUserContext must be used within a UserProvider.");
  }
  return context;
}
