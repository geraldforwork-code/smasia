using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;
using SmAsia.Web.Pages.Shared;
using SmAsia.Web.Services.Forecasting;

namespace SmAsia.Web.Pages.Products;

public class DetailsModel(AppDbContext db, InventoryService inventory, ForecastService forecasts) : PageModel
{
    public Product Product { get; set; } = null!;
    public List<StockMovement> Movements { get; set; } = [];
    public List<SupplierProduct> SupplierItems { get; set; } = [];
    public List<ProductAlias> Aliases { get; set; } = [];
    public ForecastRow? Forecast { get; set; }
    public List<(DateOnly Week, decimal Units)> WeeklySales { get; set; } = [];
    public List<PurchaseOrderLine> OpenPoLines { get; set; } = [];

    public class AdjustInput
    {
        public MovementType Type { get; set; } = MovementType.Count;
        public decimal Quantity { get; set; }
        public string? Note { get; set; }
    }
    [BindProperty] public AdjustInput Adjust { get; set; } = new();

    public async Task<IActionResult> OnGetAsync(int id)
    {
        var p = await db.Products.Include(x => x.Category).Include(x => x.PreferredSupplier).FirstOrDefaultAsync(x => x.Id == id);
        if (p == null) return NotFound();
        Product = p;
        Movements = await db.StockMovements.Where(m => m.ProductId == id).OrderByDescending(m => m.OccurredAt).ThenByDescending(m => m.Id).Take(100).ToListAsync();
        SupplierItems = await db.SupplierProducts.Include(s => s.Supplier).Where(s => s.ProductId == id).ToListAsync();
        Aliases = await db.ProductAliases.Where(a => a.ProductId == id).ToListAsync();
        OpenPoLines = await db.PurchaseOrderLines.Include(l => l.PurchaseOrder).ThenInclude(p => p.Supplier)
            .Where(l => l.ProductId == id && (l.PurchaseOrder.Status == PurchaseOrderStatus.Draft || l.PurchaseOrder.Status == PurchaseOrderStatus.Sent || l.PurchaseOrder.Status == PurchaseOrderStatus.PartiallyReceived))
            .ToListAsync();
        Forecast = (await forecasts.BuildAsync(productId: id)).FirstOrDefault();

        var last = await db.SalesLines.MaxAsync(s => (DateOnly?)s.SaleDate);
        if (last != null)
        {
            var from = last.Value.AddDays(-7 * 16 + 1);
            var daily = await db.SalesLines.Where(s => s.ProductId == id && s.SaleDate >= from)
                .GroupBy(s => s.SaleDate).Select(g => new { g.Key, Q = g.Sum(x => x.Quantity) }).ToListAsync();
            WeeklySales = Enumerable.Range(0, 16).Select(w =>
            {
                var s = from.AddDays(w * 7);
                return (s, daily.Where(d => d.Key >= s && d.Key <= s.AddDays(6)).Sum(d => d.Q));
            }).ToList();
        }
        return Page();
    }

    public async Task<IActionResult> OnPostAdjustAsync(int id)
    {
        var p = await db.Products.FindAsync(id);
        if (p == null) return NotFound();
        switch (Adjust.Type)
        {
            case MovementType.Count:
                if (inventory.SetCount(p, Adjust.Quantity, "Manual count", Adjust.Note) == null)
                {
                    TempData["Message"] = "Count matches the system quantity â€” nothing changed.";
                    return RedirectToPage(new { id });
                }
                break;
            case MovementType.Wastage:
                inventory.Move(p, MovementType.Wastage, -Math.Abs(Adjust.Quantity), "Wastage", Adjust.Note);
                break;
            default:
                if (Adjust.Quantity == 0) return RedirectToPage(new { id });
                inventory.Move(p, MovementType.Adjustment, Adjust.Quantity, "Manual adjustment", Adjust.Note);
                break;
        }
        await db.SaveChangesAsync();
        TempData["Message"] = $"Stock updated. On hand is now {Fmt.Qty(p.QtyOnHand)}.";
        return RedirectToPage(new { id });
    }

    public async Task<IActionResult> OnPostDeleteAliasAsync(int id, int aliasId)
    {
        await db.ProductAliases.Where(a => a.Id == aliasId && a.ProductId == id).ExecuteDeleteAsync();
        return RedirectToPage(new { id });
    }

    public async Task<IActionResult> OnPostDeleteSupplierItemAsync(int id, int itemId)
    {
        await db.SupplierProducts.Where(s => s.Id == itemId && s.ProductId == id).ExecuteDeleteAsync();
        return RedirectToPage(new { id });
    }
}
