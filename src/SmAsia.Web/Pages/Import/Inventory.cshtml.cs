using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services.Import;

namespace SmAsia.Web.Pages.Import;

public class InventoryModel(AppDbContext db, UploadStore uploads, InventoryImporter importer) : PageModel
{
    [BindProperty(SupportsGet = true)] public string? Token { get; set; }
    [BindProperty(SupportsGet = true)] public string? Sheet { get; set; }
    [BindProperty(SupportsGet = true)] public int? HeaderRow { get; set; }
    [BindProperty] public Dictionary<string, int>? Map { get; set; }
    [BindProperty] public IFormFile? Upload { get; set; }
    [BindProperty] public bool CreateNew { get; set; } = true;
    [BindProperty] public bool UpdateExisting { get; set; } = true;
    [BindProperty] public bool SetStock { get; set; } = true;
    [BindProperty] public CountMode CountMode { get; set; } = CountMode.SecondIfPresent;
    [BindProperty] public int? SupplierId { get; set; }

    public MappingView? Mapping { get; set; }
    public List<string> Errors { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];

    public async Task<IActionResult> OnGetAsync()
    {
        Suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
        if (Token == null) return Page();
        var path = uploads.PathFor(Token);
        if (path == null) { Errors.Add("That upload has expired — please upload the file again."); Token = null; return Page(); }
        BuildMapping(path, null);
        return Page();
    }

    public async Task<IActionResult> OnPostUploadAsync()
    {
        var ext = Upload == null ? "" : Path.GetExtension(Upload.FileName).ToLowerInvariant();
        if (Upload == null || !TabularFile.SupportedExtensions.Contains(ext))
        {
            Errors.Add(ext == ".xls" ? "Save the workbook as .xlsx first." : "Upload an Excel (.xlsx) or CSV file.");
            Suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
            return Page();
        }
        var token = await uploads.SaveAsync(Upload);
        return RedirectToPage(new { token });
    }

    public async Task<IActionResult> OnPostImportAsync()
    {
        var path = uploads.PathFor(Token);
        if (path == null) { Errors.Add("That upload has expired — please upload the file again."); Token = null; return Page(); }
        var file = TabularFile.Read(path, Sheet);
        var map = MappingView.Clean(Map);
        var result = await importer.ImportAsync(file, $"{uploads.OriginalName(Token!)}{(file.Sheet != null ? $" [{file.Sheet}]" : "")}", new InventoryImportOptions
        {
            HeaderRow = HeaderRow ?? 0, Mapping = map, CreateNew = CreateNew, UpdateExisting = UpdateExisting,
            SetStock = SetStock, CountMode = CountMode, SupplierId = SupplierId,
        });
        if (!result.Ok)
        {
            Errors = result.Errors;
            Suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
            BuildMapping(path, map);
            return Page();
        }
        TempData["Message"] = "Inventory imported. " + result.Batch!.Log;
        return RedirectToPage("Batch", new { id = result.Batch.Id });
    }

    private void BuildMapping(string path, Dictionary<string, int>? map)
    {
        var file = TabularFile.Read(path, Sheet);
        Sheet = file.Sheet;
        HeaderRow ??= file.DetectHeaderRow(ImportFields.Inventory.SelectMany(f => f.Keywords));
        Mapping = new MappingView
        {
            File = file, Token = Token!, OriginalName = uploads.OriginalName(Token!), HeaderRow = HeaderRow.Value,
            Fields = ImportFields.Inventory, Map = map ?? ImportFields.AutoMap(ImportFields.Inventory, file.Header(HeaderRow.Value)),
        };
    }
}
