using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services.Parsing;

namespace SmAsia.Web.Services.Import;

public class SalesImportOptions
{
    public int HeaderRow { get; set; }
    public Dictionary<string, int> Mapping { get; set; } = new();
    /// <summary>Used when the report has no date column: sales are spread evenly over this period.</summary>
    public DateOnly? PeriodFrom { get; set; }
    public DateOnly? PeriodTo { get; set; }
    public bool DeductStock { get; set; } = true;
    public bool AllowDuplicateFile { get; set; }
}

public class ImportResult
{
    public ImportBatch? Batch { get; set; }
    public List<string> Errors { get; } = [];
    public bool Ok => Errors.Count == 0 && Batch != null;
}

/// <summary>Imports an EPOS sales report (any CSV/XLSX layout) into daily sales and, optionally, stock.</summary>
public class SalesImporter(AppDbContext db, InventoryService inventory)
{
    public async Task<Dictionary<string, int>?> SavedMappingAsync(string?[] header)
    {
        var sig = TabularFile.HeaderSignature(header);
        var profile = await db.ImportProfiles.FirstOrDefaultAsync(p => p.Type == ImportType.Sales && p.HeaderSignature == sig);
        return profile == null ? null : JsonSerializer.Deserialize<Dictionary<string, int>>(profile.MappingJson);
    }

    public async Task<ImportResult> ImportAsync(TabularFile file, string fileName, SalesImportOptions o)
    {
        var result = new ImportResult();
        var map = o.Mapping;
        if (!map.ContainsKey("Quantity")) result.Errors.Add("Map the Quantity column.");
        if (!map.ContainsKey("Code") && !map.ContainsKey("Name")) result.Errors.Add("Map a Barcode/PLU column or an Item description column so rows can be matched to products.");
        bool hasDate = map.ContainsKey("Date");
        if (!hasDate && (o.PeriodFrom == null || o.PeriodTo == null)) result.Errors.Add("Map a Date column, or enter the period this report covers.");
        if (!hasDate && o.PeriodFrom > o.PeriodTo) result.Errors.Add("The period start is after the period end.");
        if (!o.AllowDuplicateFile && await db.ImportBatches.AnyAsync(b => b.FileHash == file.Hash && !b.Reversed && b.Type == ImportType.Sales))
            result.Errors.Add("This exact file has already been imported. Tick \"Import anyway\" if that is intended.");
        if (result.Errors.Count > 0) return result;

        string? Cell(string?[] row, string key) => map.TryGetValue(key, out var i) && i >= 0 && i < row.Length ? row[i] : null;

        var matcher = await ProductMatcher.LoadAsync(db);
        var matched = new Dictionary<(int ProductId, DateOnly Date), (decimal Qty, decimal Amt)>();
        var unmatched = new Dictionary<(string? Code, string? Name, DateOnly? Date), (decimal Qty, decimal Amt)>();
        int read = 0, skipped = 0;
        DateOnly? minDate = null, maxDate = null;

        foreach (var row in file.Rows.Skip(o.HeaderRow + 1))
        {
            read++;
            var qty = TabularFile.ParseNumber(Cell(row, "Quantity"));
            var code = Cell(row, "Code")?.Trim();
            var name = Cell(row, "Name")?.Trim();
            if (qty == null || (string.IsNullOrEmpty(code) && string.IsNullOrEmpty(name))) { skipped++; continue; }
            if (string.IsNullOrEmpty(code) && name!.Contains("total", StringComparison.OrdinalIgnoreCase)) { skipped++; continue; }

            DateOnly date;
            if (hasDate)
            {
                var d = ProductText.ParseLooseDate(Cell(row, "Date"));
                if (d == null) { skipped++; continue; }
                date = d.Value;
            }
            else date = o.PeriodFrom!.Value;

            minDate = minDate == null || date < minDate ? date : minDate;
            maxDate = maxDate == null || date > maxDate ? date : maxDate;
            var amt = TabularFile.ParseNumber(Cell(row, "Amount")) ?? 0;

            var match = matcher.MatchReportRow(code, name);
            if (match != null)
            {
                var k = (match.ProductId, date);
                var cur = matched.GetValueOrDefault(k);
                matched[k] = (cur.Qty + qty.Value, cur.Amt + amt);
            }
            else
            {
                var k = (code, name, hasDate ? date : (DateOnly?)null);
                var cur = unmatched.GetValueOrDefault(k);
                unmatched[k] = (cur.Qty + qty.Value, cur.Amt + amt);
            }
        }

        if (matched.Count == 0 && unmatched.Count == 0)
        {
            result.Errors.Add($"No sales rows were found below header row {o.HeaderRow + 1}. Check the header row and column mapping.");
            return result;
        }

        var batch = new ImportBatch
        {
            Type = ImportType.Sales,
            FileName = fileName,
            FileHash = file.Hash,
            PeriodFrom = hasDate ? minDate : o.PeriodFrom,
            PeriodTo = hasDate ? maxDate : o.PeriodTo,
            RowsRead = read,
            RowsSkipped = skipped,
            RowsImported = matched.Count,
            RowsUnmatched = unmatched.Count,
            AffectedStock = o.DeductStock,
        };

        await using var tx = await db.Database.BeginTransactionAsync();
        db.ImportBatches.Add(batch);
        await db.SaveChangesAsync();

        var productIds = matched.Keys.Select(k => k.ProductId).Distinct().ToList();
        var products = await db.Products.Where(p => productIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id);

        foreach (var ((pid, date), (qty, amt)) in matched)
            AddSales(batch, pid, date, hasDate ? null : o.PeriodTo, qty, amt);

        if (o.DeductStock)
        {
            var lastCounts = await LastCountsAsync(productIds);
            decimal notDeducted = 0;
            foreach (var g in matched.GroupBy(k => k.Key.ProductId))
            {
                var lastCount = lastCounts.TryGetValue(g.Key, out var lc) ? lc : (DateTime?)null;
                var total = g.Sum(x => DeductibleQty(x.Key.Date, hasDate ? null : o.PeriodTo, x.Value.Qty, lastCount));
                notDeducted += g.Sum(x => x.Value.Qty) - total;
                if (total == 0) continue;
                var when = (hasDate ? g.Max(x => x.Key.Date) : o.PeriodTo!.Value).ToDateTime(new TimeOnly(23, 59));
                inventory.Move(products[g.Key], MovementType.Sale, -total, $"Sales import #{batch.Id}", fileName, when, importBatchId: batch.Id);
            }
            if (notDeducted > 0)
                batch.Log = $"{notDeducted:#,##0.##} units sold before the products' last stock count were not deducted from stock (the count already reflects them); they are still used for forecasting.";
        }

        foreach (var ((code, name, date), (qty, amt)) in unmatched)
            db.ImportIssues.Add(new ImportIssue
            {
                ImportBatchId = batch.Id, Code = code, Name = name,
                SaleDate = date ?? o.PeriodFrom, PeriodTo = date == null ? o.PeriodTo : null,
                Quantity = qty, Amount = amt,
            });

        await SaveProfileAsync(file.Header(o.HeaderRow), map);
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        result.Batch = batch;
        return result;
    }

    /// <summary>When each product was last counted (or first loaded with an opening quantity).</summary>
    private async Task<Dictionary<int, DateTime>> LastCountsAsync(IEnumerable<int> productIds)
    {
        var ids = productIds.Distinct().ToList();
        return await db.StockMovements
            .Where(m => ids.Contains(m.ProductId) && (m.Type == MovementType.Count || m.Type == MovementType.Opening))
            .GroupBy(m => m.ProductId)
            .Select(g => new { g.Key, At = g.Max(m => m.OccurredAt) })
            .ToDictionaryAsync(x => x.Key, x => x.At);
    }

    /// <summary>
    /// Whether a sale on this date still needs to come off stock. Sales before the latest count are already
    /// reflected in it. A count entered before noon is treated as start-of-day, after noon as end-of-day.
    /// </summary>
    public static bool AfterLastCount(DateOnly saleDate, DateTime? lastCount)
    {
        if (lastCount == null) return true;
        var countDay = DateOnly.FromDateTime(lastCount.Value);
        return saleDate > countDay || (saleDate == countDay && lastCount.Value.Hour < 12);
    }

    /// <summary>The part of a sale (or of a period's sales, spread evenly by day) that falls after the last count.</summary>
    public static decimal DeductibleQty(DateOnly from, DateOnly? to, decimal qty, DateTime? lastCount)
    {
        int days = to == null ? 1 : to.Value.DayNumber - from.DayNumber + 1;
        int counting = Enumerable.Range(0, days).Count(i => AfterLastCount(from.AddDays(i), lastCount));
        return counting == days ? qty : Math.Round(qty * counting / days, 4);
    }

    /// <summary>Adds sales for one product; a period is spread evenly across its days so daily forecasting still works.</summary>
    private void AddSales(ImportBatch batch, int productId, DateOnly from, DateOnly? to, decimal qty, decimal amt)
    {
        int days = to == null ? 1 : to.Value.DayNumber - from.DayNumber + 1;
        for (int i = 0; i < days; i++)
            db.SalesLines.Add(new SalesLine
            {
                ProductId = productId, ImportBatchId = batch.Id, SaleDate = from.AddDays(i),
                Quantity = Math.Round(qty / days, 4), NetAmount = Math.Round(amt / days, 4),
            });
    }

    /// <summary>Links an unmatched row to a product, records its sales, and remembers the code/name for next time.</summary>
    public async Task ResolveIssueAsync(int issueId, int productId, bool applyToSameCode)
    {
        var issue = await db.ImportIssues.Include(i => i.ImportBatch).FirstAsync(i => i.Id == issueId);
        var product = await db.Products.FindAsync(productId) ?? throw new InvalidOperationException("Product not found");
        var issues = applyToSameCode
            ? await db.ImportIssues.Include(i => i.ImportBatch)
                .Where(i => !i.Resolved && i.ImportBatchId == issue.ImportBatchId && i.Code == issue.Code && i.Name == issue.Name).ToListAsync()
            : [issue];

        var lastCount = (await LastCountsAsync([productId])).TryGetValue(productId, out var lc) ? lc : (DateTime?)null;
        foreach (var i in issues)
        {
            if (i.Resolved || i.ImportBatch.Reversed) continue;
            var date = i.SaleDate ?? DateOnly.FromDateTime(DateTime.Today);
            AddSales(i.ImportBatch, productId, date, i.PeriodTo, i.Quantity, i.Amount);
            var deduct = DeductibleQty(date, i.PeriodTo, i.Quantity, lastCount);
            if (i.ImportBatch.AffectedStock && deduct != 0)
                inventory.Move(product, MovementType.Sale, -deduct, $"Sales import #{i.ImportBatchId}",
                    $"Resolved: {i.Code} {i.Name}".Trim(), (i.PeriodTo ?? date).ToDateTime(new TimeOnly(23, 59)), importBatchId: i.ImportBatchId);
            i.Resolved = true;
            i.ImportBatch.RowsImported++;
            i.ImportBatch.RowsUnmatched--;
        }

        var aliasExists = await db.ProductAliases.AnyAsync(a => a.ProductId == productId && a.Code == issue.Code && a.Name == issue.Name);
        if (!aliasExists) db.ProductAliases.Add(new ProductAlias { ProductId = productId, Code = issue.Code, Name = issue.Name });
        await db.SaveChangesAsync();
    }

    /// <summary>Removes a sales import's sales and restores the stock it deducted.</summary>
    public async Task ReverseAsync(int batchId)
    {
        var batch = await db.ImportBatches.FirstAsync(b => b.Id == batchId);
        if (batch.Reversed || batch.Type != ImportType.Sales) return;
        await using var tx = await db.Database.BeginTransactionAsync();
        var movements = await db.StockMovements.Include(m => m.Product).Where(m => m.ImportBatchId == batchId).ToListAsync();
        foreach (var m in movements)
        {
            m.Product.QtyOnHand -= m.Quantity;
            m.Product.UpdatedAt = DateTime.UtcNow;
        }
        db.StockMovements.RemoveRange(movements);
        await db.SalesLines.Where(s => s.ImportBatchId == batchId).ExecuteDeleteAsync();
        batch.Reversed = true;
        batch.Log = $"Reversed on {DateTime.Now:g} — " + batch.Log;
        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }

    private async Task SaveProfileAsync(string?[] header, Dictionary<string, int> map)
    {
        var sig = TabularFile.HeaderSignature(header);
        var profile = await db.ImportProfiles.FirstOrDefaultAsync(p => p.Type == ImportType.Sales && p.HeaderSignature == sig);
        if (profile == null)
        {
            profile = new ImportProfile { Type = ImportType.Sales, HeaderSignature = sig, Name = string.Join(", ", header.Where(h => h != null).Take(4)) };
            db.ImportProfiles.Add(profile);
        }
        profile.MappingJson = JsonSerializer.Serialize(map);
        profile.UpdatedAt = DateTime.Now;
    }
}
