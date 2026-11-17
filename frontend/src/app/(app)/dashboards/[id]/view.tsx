"use client";

import { useParams } from "next/navigation";
import { DashboardsHome } from "../view";

/** Deep link to one dashboard: the same home view with that dashboard selected. */
export default function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  return <DashboardsHome selectedId={id} />;
}
