using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.Import;

public class IndexModel(AppDbContext db) : PageModel
{
    public List<ImportBatch> Batches { get; set; } = [];
    public int OpenIssues { get; set; }

    public async Task OnGetAsync()
    {
        Batches = await db.ImportBatches.OrderByDescending(b => b.ImportedAt).Take(200).ToListAsync();
        OpenIssues = await db.ImportIssues.CountAsync(i => !i.Resolved && !i.ImportBatch.Reversed);
    }
}
