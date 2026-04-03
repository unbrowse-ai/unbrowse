"use client";

import { useSearchParams } from "next/navigation";
import { SearchBar } from "@/components/search-bar";

export function SearchBarWithParams() {
  const searchParams = useSearchParams();
  return <SearchBar initial={searchParams.get("q") ?? ""} />;
}
