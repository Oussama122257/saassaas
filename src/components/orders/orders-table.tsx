"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState } from "@tanstack/react-table";
import { MoreHorizontal, Phone, Printer, Truck, Eye, Download, Users } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { formatDzd, formatDateTime, relativeTime } from "@/lib/utils";
import { wilayaName } from "@/lib/wilayas";
import { bulkReassignAction } from "@/app/[locale]/(app)/orders/actions";
import type { OrderRowDto } from "./dto";

interface Props {
  rows: OrderRowDto[];
  locale: string;
  timezone: string;
  canBulk: boolean;
  agents: Array<{ id: string; name: string }>;
  exportHref: string;
}

export function OrdersTable({ rows, locale, timezone, canBulk, agents, exportHref }: Props) {
  const t = useTranslations("orders");
  const tc = useTranslations("common");
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [reassignOpen, setReassignOpen] = useState(false);
  const [target, setTarget] = useState(agents[0]?.id ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const columns = useMemo<ColumnDef<OrderRowDto>[]>(() => {
    const cols: ColumnDef<OrderRowDto>[] = [];
    if (canBulk) {
      cols.push({
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
            aria-label="select all"
          />
        ),
        cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} aria-label="select row" />,
        size: 32,
      });
    }
    cols.push(
      {
        accessorKey: "seq",
        header: t("columns.seq"),
        cell: ({ row }) => (
          <Link href={`/orders/${row.original.id}`} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
            #{row.original.seq}
          </Link>
        ),
      },
      {
        accessorKey: "createdAt",
        header: t("columns.created"),
        cell: ({ getValue }) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(getValue<string>(), locale, timezone)}</span>,
      },
      {
        accessorKey: "customerName",
        header: t("columns.customer"),
        cell: ({ row }) => (
          <div className="min-w-36">
            <div className="flex items-center gap-1 font-medium">
              {row.original.customerName ?? "—"}
              {row.original.isRepeatCustomer ? <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-900 dark:bg-violet-950 dark:text-violet-200" title={t("repeatBadge")}>↻</span> : null}
              {row.original.mappingErrors.length > 0 ? <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900" title={row.original.mappingErrors.join(", ")}>!</span> : null}
            </div>
            <div className="font-mono text-xs text-muted-foreground" dir="ltr">
              {row.original.customerPhone}
            </div>
          </div>
        ),
      },
      { accessorKey: "items", header: t("columns.items"), cell: ({ getValue }) => <span className="line-clamp-2 max-w-56 text-xs">{getValue<string>()}</span> },
      {
        accessorKey: "wilayaCode",
        header: t("columns.wilaya"),
        cell: ({ row }) => (
          <div className="text-xs">
            <div>{wilayaName(row.original.wilayaCode, locale)}</div>
            <div className="text-muted-foreground">{row.original.commune ?? ""}</div>
          </div>
        ),
      },
      { accessorKey: "total", header: t("columns.total"), cell: ({ getValue }) => <span className="whitespace-nowrap font-medium">{formatDzd(getValue<number>(), locale)}</span> },
      {
        accessorKey: "status",
        header: t("columns.status"),
        // attempt count next to the status, e.g. "مكالمة 2 · 5" (section 19c.1)
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <StatusBadge status={row.original.status} locale={locale} />
            {row.original.attemptCount > 0 ? <span className="font-mono text-xs text-muted-foreground" data-testid="attempt-count">· {row.original.attemptCount}</span> : null}
          </span>
        ),
      },
      { accessorKey: "assignedTo", header: t("columns.agent"), cell: ({ getValue }) => <span className="text-xs">{getValue<string | null>() ?? "—"}</span> },
      { accessorKey: "store", header: t("columns.store"), cell: ({ getValue }) => <span className="text-xs text-muted-foreground">{getValue<string>()}</span> },
      {
        accessorKey: "lastActivityAt",
        header: t("columns.lastActivity"),
        cell: ({ getValue }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{relativeTime(getValue<string>(), locale)}</span>,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => <RowActions row={row.original} />,
      },
    );
    return cols;
  }, [canBulk, locale, timezone, t]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: { rowSelection: selection },
    onRowSelectionChange: setSelection,
    getRowId: (r) => r.id,
    enableRowSelection: canBulk,
  });

  const selectedIds = Object.keys(selection).filter((k) => selection[k]);

  return (
    <div className="space-y-3">
      {canBulk ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="bulk-bar">
          <span className="text-muted-foreground">{tc("selected", { count: selectedIds.length })}</span>
          <Button variant="outline" size="sm" disabled={selectedIds.length === 0 || agents.length === 0} onClick={() => setReassignOpen(true)}>
            <Users className="size-4" /> {t("bulk.reassign")}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={selectedIds.length ? `${exportHref}&ids=${selectedIds.join(",")}` : exportHref} data-testid="export-csv">
              <Download className="size-4" /> {t("bulk.exportCsv")}
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`${selectedIds.length ? `${exportHref}&ids=${selectedIds.join(",")}` : exportHref}&format=xls`} data-testid="export-xls">
              <Download className="size-4" /> {t("exportExcel")}
            </a>
          </Button>
          {message ? <span className="text-emerald-700">{message}</span> : null}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} className="whitespace-nowrap text-start">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() ? "selected" : undefined} data-testid="order-row">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("bulk.reassignTitle", { count: selectedIds.length })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-agent">{t("bulk.reassignTo")}</Label>
            <select id="bulk-agent" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={target} onChange={(e) => setTarget(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReassignOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button
              disabled={pending || !target}
              onClick={() =>
                start(async () => {
                  const res = await bulkReassignAction({ orderIds: selectedIds, toUserId: target });
                  setReassignOpen(false);
                  setSelection({});
                  setMessage(res.ok ? t("bulk.done", { count: res.count }) : res.message);
                })
              }
            >
              {t("bulk.reassign")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RowActions({ row }: { row: OrderRowDto }) {
  const t = useTranslations("orders.quick");
  const tc = useTranslations("common");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={tc("actions")} data-testid="row-actions">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/orders/${row.id}`}>
            <Eye className="size-4" /> {t("details")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`tel:${row.customerPhone}`}>
            <Phone className="size-4" /> {t("call")}
          </a>
        </DropdownMenuItem>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DropdownMenuItem disabled>
                <Truck className="size-4" /> {t("sendToCourier")}
              </DropdownMenuItem>
            </div>
          </TooltipTrigger>
          <TooltipContent>{tc("phase", { phase: 4 })}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DropdownMenuItem disabled={!row.trackingNumber}>
                <Printer className="size-4" /> {t("printLabel")}
              </DropdownMenuItem>
            </div>
          </TooltipTrigger>
          <TooltipContent>{tc("phase", { phase: 4 })}</TooltipContent>
        </Tooltip>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
