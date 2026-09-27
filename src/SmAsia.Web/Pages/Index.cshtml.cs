using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services.Forecasting;

namespace SmAsia.Web.Pages;

public class IndexModel(AppDbContext db, ForecastService forecast) : PageModel
{
    public int ProductCount { get; set; }
    public decimal StockValue { get; set; }
    public int OutOfStock { get; set; }
    public int ReorderCount { get; set; }
    public int OpenPoCount { get; set; }
    public decimal OpenPoValue { get; set; }
    public int ExpiringCount { get; set; }
    public decimal Sales28Units { get; set; }
    public decimal Sales28Amount { get; set; }
    public DateOnly? LastSalesDate { get; set; }

    public List<ForecastRow> Reorder { get; set; } = [];
    public List<Product> Expiring { get; set; } = [];
    public List<Receipt> RecentReceipts { get; set; } = [];
    public List<ImportBatch> RecentImports { get; set; } = [];
    public List<(DateOnly Week, decimal Units, decimal Amount)> WeeklySales { get; set; } = [];

    public async Task OnGetAsync()
    {
        var today = DateOnly.FromDateTime(DateTime.Today);
        var active = db.Products.Where(p => p.IsActive);
        ProductCount = await active.CountAsync();
        StockValue = await active.Where(p => p.QtyOnHand > 0).SumAsync(p => (decimal?)(p.QtyOnHand * p.UnitCost)) ?? 0;
        OutOfStock = await active.CountAsync(p => p.QtyOnHand <= 0);

        var open = db.PurchaseOrders.Where(p => p.Status == PurchaseOrderStatus.Draft || p.Status == PurchaseOrderStatus.Sent || p.Status == PurchaseOrderStatus.PartiallyReceived);
        OpenPoCount = await open.CountAsync();
        OpenPoValue = await open.SelectMany(p => p.Lines).SumAsync(l => (decimal?)(l.QtyCases * l.CaseCost)) ?? 0;

        var expiryLimit = today.AddDays(60);
        var expiring = active.Where(p => p.NearestExpiry != null && p.NearestExpiry <= expiryLimit && p.QtyOnHand > 0);
        ExpiringCount = await expiring.CountAsync();
        Expiring = await expiring.OrderBy(p => p.NearestExpiry).Take(8).ToListAsync();

        LastSalesDate = await db.SalesLines.MaxAsync(s => (DateOnly?)s.SaleDate);
        if (LastSalesDate is { } last)
        {
            var from28 = last.AddDays(-27);
            var s28 = db.SalesLines.Where(s => s.SaleDate >= from28 && s.SaleDate <= last);
            Sales28Units = await s28.SumAsync(s => (decimal?)s.Quantity) ?? 0;
            Sales28Amount = await s28.SumAsync(s => (decimal?)s.NetAmount) ?? 0;

            var from = last.AddDays(-7 * 12 + 1);
            var daily = await db.SalesLines.Where(s => s.SaleDate >= from && s.SaleDate <= last)
                .GroupBy(s => s.SaleDate).Select(g => new { g.Key, U = g.Sum(x => x.Quantity), A = g.Sum(x => x.NetAmount) }).ToListAsync();
            WeeklySales = Enumerable.Range(0, 12).Select(w =>
            {
                var start = from.AddDays(w * 7);
                var end = start.AddDays(6);
                var inWeek = daily.Where(d => d.Key >= start && d.Key <= end).ToList();
                return (start, inWeek.Sum(d => d.U), inWeek.Sum(d => d.A));
            }).ToList();
        }

        var rows = await forecast.BuildAsync();
        var needing = rows.Where(r => r.Advice.SuggestedUnits > 0).ToList();
        ReorderCount = needing.Count;
        Reorder = needing.OrderBy(r => r.Advice.DaysOfCover ?? 0).Take(10).ToList();

        RecentReceipts = await db.Receipts.Include(r => r.Supplier).OrderByDescending(r => r.CreatedAt).Take(5).ToListAsync();
        RecentImports = await db.ImportBatches.OrderByDescending(b => b.ImportedAt).Take(5).ToListAsync();
    }
}
