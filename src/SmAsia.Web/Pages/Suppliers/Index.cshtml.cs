using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.Suppliers;

public class IndexModel(AppDbContext db) : PageModel
{
    public record Row(Supplier Supplier, int Products, int OpenPos, DateOnly? LastReceipt);
    public List<Row> Rows { get; set; } = [];

    public async Task OnGetAsync()
    {
        var suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
        var products = await db.Products.Where(p => p.PreferredSupplierId != null).GroupBy(p => p.PreferredSupplierId!.Value).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N);
        var pos = await db.PurchaseOrders.Where(p => p.Status == PurchaseOrderStatus.Draft || p.Status == PurchaseOrderStatus.Sent || p.Status == PurchaseOrderStatus.PartiallyReceived)
            .GroupBy(p => p.SupplierId).Select(g => new { g.Key, N = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.N);
        var receipts = await db.Receipts.Where(r => r.Status == ReceiptStatus.Posted).GroupBy(r => r.SupplierId)
            .Select(g => new { g.Key, D = g.Max(r => r.ReceivedDate) }).ToDictionaryAsync(x => x.Key, x => (DateOnly?)x.D);
        Rows = suppliers.Select(s => new Row(s, products.GetValueOrDefault(s.Id), pos.GetValueOrDefault(s.Id), receipts.GetValueOrDefault(s.Id))).ToList();
    }
}
