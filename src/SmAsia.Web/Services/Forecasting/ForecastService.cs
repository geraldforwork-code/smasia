using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Services.Forecasting;

public class ForecastSettings
{
    public int LookbackDays { get; set; } = 182;
    public double ServiceLevel { get; set; } = 0.95;
    public int DefaultLeadTimeDays { get; set; } = 7;
    public int DefaultReviewDays { get; set; } = 14;
}

public class ForecastRow
{
    public required Product Product { get; init; }
    public Supplier? Supplier { get; init; }
    public decimal OnOrder { get; init; }
    public required DemandForecast Forecast { get; init; }
    public required ReorderAdvice Advice { get; init; }
    public int LeadTimeDays { get; init; }
}

public class ForecastService(AppDbContext db, IConfiguration config)
{
    public ForecastSettings Settings { get; } = config.GetSection("Forecast").Get<ForecastSettings>() ?? new();

    /// <summary>The first and last dates with imported sales, or null if nothing has been imported.</summary>
    public async Task<(DateOnly First, DateOnly Last)?> SalesRangeAsync()
    {
        if (!await db.SalesLines.AnyAsync()) return null;
        return (await db.SalesLines.MinAsync(s => s.SaleDate), await db.SalesLines.MaxAsync(s => s.SaleDate));
    }

    public async Task<List<ForecastRow>> BuildAsync(int? productId = null, int? supplierId = null, int? categoryId = null)
    {
        var range = await SalesRangeAsync();
        // Forecast up to the last imported day so a late import doesn't look like a sales drop.
        var lastDay = range?.Last ?? DateOnly.FromDateTime(DateTime.Today.AddDays(-1));
        var firstDay = range == null ? lastDay : Max(range.Value.First, lastDay.AddDays(-Settings.LookbackDays + 1));
        int days = lastDay.DayNumber - firstDay.DayNumber + 1;

        var q = db.Products.Include(p => p.PreferredSupplier).Include(p => p.Category).Where(p => p.IsActive);
        if (productId != null) q = q.Where(p => p.Id == productId);
        if (supplierId != null) q = q.Where(p => p.PreferredSupplierId == supplierId);
        if (categoryId != null) q = q.Where(p => p.CategoryId == categoryId);
        var products = await q.AsNoTracking().ToListAsync();
        var ids = products.Select(p => p.Id).ToList();

        var salesQ = db.SalesLines.Where(s => s.SaleDate >= firstDay && s.SaleDate <= lastDay);
        if (productId != null) salesQ = salesQ.Where(s => s.ProductId == productId);
        var sales = await salesQ
            .GroupBy(s => new { s.ProductId, s.SaleDate })
            .Select(g => new { g.Key.ProductId, g.Key.SaleDate, Qty = g.Sum(x => x.Quantity) })
            .ToListAsync();
        var byProduct = sales.GroupBy(s => s.ProductId).ToDictionary(g => g.Key, g => g.ToList());

        var onOrder = await db.PurchaseOrderLines
            .Where(l => l.PurchaseOrder.Status == PurchaseOrderStatus.Draft || l.PurchaseOrder.Status == PurchaseOrderStatus.Sent || l.PurchaseOrder.Status == PurchaseOrderStatus.PartiallyReceived)
            .GroupBy(l => l.ProductId)
            .Select(g => new { ProductId = g.Key, Units = g.Sum(l => l.QtyCases * l.UnitsPerCase - l.QtyReceivedUnits) })
            .ToDictionaryAsync(x => x.ProductId, x => x.Units);

        var z = DemandForecaster.ZForServiceLevel(Settings.ServiceLevel);
        var today = DateOnly.FromDateTime(DateTime.Today);
        var rows = new List<ForecastRow>(products.Count);
        foreach (var p in products)
        {
            var series = new double[Math.Max(0, days)];
            if (byProduct.TryGetValue(p.Id, out var ps))
                foreach (var s in ps) series[s.SaleDate.DayNumber - firstDay.DayNumber] += (double)s.Qty;

            var f = DemandForecaster.Forecast(range == null ? [] : series, lastDay);
            var lead = p.PreferredSupplier?.LeadTimeDays ?? Settings.DefaultLeadTimeDays;
            var review = p.PreferredSupplier?.OrderCycleDays ?? Settings.DefaultReviewDays;
            var ordered = Math.Max(0, onOrder.GetValueOrDefault(p.Id));
            var advice = DemandForecaster.Advise(f, new ReorderPolicy(lead, review, z, p.UnitsPerCase, p.MinStock), p.QtyOnHand, ordered, today);
            rows.Add(new ForecastRow { Product = p, Supplier = p.PreferredSupplier, OnOrder = ordered, Forecast = f, Advice = advice, LeadTimeDays = lead });
        }
        return rows;
    }

    private static DateOnly Max(DateOnly a, DateOnly b) => a > b ? a : b;
}
