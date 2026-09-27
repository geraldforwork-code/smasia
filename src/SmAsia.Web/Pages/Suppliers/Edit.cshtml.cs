using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services.Parsing;

namespace SmAsia.Web.Pages.Suppliers;

public class EditModel(AppDbContext db, InvoiceParserRegistry parsers) : PageModel
{
    [BindProperty] public Supplier Supplier { get; set; } = new();
    public List<SupplierProduct> Items { get; set; } = [];
    public IReadOnlyList<IInvoiceParser> Parsers => parsers.Parsers;

    public async Task<IActionResult> OnGetAsync(int? id)
    {
        if (id != null)
        {
            var s = await db.Suppliers.FindAsync(id);
            if (s == null) return NotFound();
            Supplier = s;
            Items = await db.SupplierProducts.Include(x => x.Product).Where(x => x.SupplierId == id).OrderBy(x => x.SupplierItemCode).ToListAsync();
        }
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        ModelState.Remove("Supplier.Products");
        if (!ModelState.IsValid) return Page();
        if (Supplier.Id == 0) db.Suppliers.Add(Supplier);
        else db.Suppliers.Update(Supplier);
        await db.SaveChangesAsync();
        TempData["Message"] = $"Saved {Supplier.Name}.";
        return RedirectToPage("Index");
    }
}
