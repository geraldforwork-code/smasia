using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Services;

public class PurchasingService(AppDbContext db)
{
    public async Task<string> NextPoNumberAsync()
    {
        var prefix = $"PO{DateTime.Today:yyMM}-";
        var last = await db.PurchaseOrders.Where(p => p.PoNumber.StartsWith(prefix))
            .OrderByDescending(p => p.PoNumber).Select(p => p.PoNumber).FirstOrDefaultAsync();
        var seq = last != null && int.TryParse(last[prefix.Length..], out var n) ? n + 1 : 1;
        return $"{prefix}{seq:000}";
    }

    /// <summary>Builds one draft PO per supplier from (product, cases) requests.</summary>
    public async Task<List<PurchaseOrder>> CreateDraftsAsync(IEnumerable<(int ProductId, int SupplierId, decimal Cases)> items)
    {
        var list = items.Where(i => i.Cases > 0).ToList();
        var productIds = list.Select(i => i.ProductId).ToList();
        var products = await db.Products.Where(p => productIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id);
        var supplierItems = await db.SupplierProducts.Where(s => productIds.Contains(s.ProductId)).ToListAsync();

        var created = new List<PurchaseOrder>();
        foreach (var group in list.GroupBy(i => i.SupplierId))
        {
            var supplier = await db.Suppliers.FindAsync(group.Key);
            var po = new PurchaseOrder
            {
                SupplierId = group.Key,
                PoNumber = await NextPoNumberAsync(),
                ExpectedDate = DateOnly.FromDateTime(DateTime.Today.AddDays(supplier?.LeadTimeDays ?? 7)),
                Notes = "Created from reorder suggestions",
            };
            foreach (var i in group)
            {
                var p = products[i.ProductId];
                var sp = supplierItems.FirstOrDefault(s => s.ProductId == p.Id && s.SupplierId == group.Key);
                var upc = Math.Max(1, sp?.UnitsPerCase ?? p.UnitsPerCase);
                po.Lines.Add(new PurchaseOrderLine
                {
                    ProductId = p.Id,
                    SupplierItemCode = sp?.SupplierItemCode,
                    QtyCases = i.Cases,
                    UnitsPerCase = upc,
                    CaseCost = sp?.LastCaseCost ?? Math.Round(p.UnitCost * upc, 2),
                });
            }
            db.PurchaseOrders.Add(po);
            await db.SaveChangesAsync(); // save per PO so the next number is unique
            created.Add(po);
        }
        return created;
    }
}
