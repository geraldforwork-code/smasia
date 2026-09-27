using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using SmAsia.Web.Services.Import;

namespace SmAsia.Web.Pages.Import;

public class SalesModel(UploadStore uploads, SalesImporter importer) : PageModel
{
    [BindProperty(SupportsGet = true)] public string? Token { get; set; }
    [BindProperty(SupportsGet = true)] public string? Sheet { get; set; }
    [BindProperty(SupportsGet = true)] public int? HeaderRow { get; set; }
    [BindProperty] public Dictionary<string, int>? Map { get; set; }
    [BindProperty] public DateOnly? PeriodFrom { get; set; }
    [BindProperty] public DateOnly? PeriodTo { get; set; }
    [BindProperty] public bool DeductStock { get; set; } = true;
    [BindProperty] public bool AllowDuplicate { get; set; }
    [BindProperty] public IFormFile? Upload { get; set; }

    public MappingView? Mapping { get; set; }
    public List<string> Errors { get; set; } = [];

    public async Task<IActionResult> OnGetAsync()
    {
        if (Token == null) return Page();
        var path = uploads.PathFor(Token);
        if (path == null) { Errors.Add("That upload has expired — please upload the file again."); Token = null; return Page(); }
        await BuildMappingAsync(path, null);
        return Page();
    }

    public async Task<IActionResult> OnPostUploadAsync()
    {
        if (Upload == null || Upload.Length == 0) { Errors.Add("Choose a file to upload."); return Page(); }
        var ext = Path.GetExtension(Upload.FileName).ToLowerInvariant();
        if (!TabularFile.SupportedExtensions.Contains(ext))
        {
            Errors.Add(ext == ".xls"
                ? "Old .xls files aren't supported — open it in Excel and save as .xlsx or .csv."
                : ext == ".pdf" ? "PDF sales reports can't be imported — export the report from the EPOS as CSV or Excel." : "Upload a CSV or Excel (.xlsx) file.");
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
        var result = await importer.ImportAsync(file, uploads.OriginalName(Token!), new SalesImportOptions
        {
            HeaderRow = HeaderRow ?? 0, Mapping = map, PeriodFrom = PeriodFrom, PeriodTo = PeriodTo,
            DeductStock = DeductStock, AllowDuplicateFile = AllowDuplicate,
        });
        if (!result.Ok)
        {
            Errors = result.Errors;
            await BuildMappingAsync(path, map);
            return Page();
        }
        var b = result.Batch!;
        TempData["Message"] = $"Imported {b.RowsImported} product-day sales rows." + (b.RowsUnmatched > 0 ? $" {b.RowsUnmatched} rows didn't match a product — link them below." : "");
        return RedirectToPage("Batch", new { id = b.Id });
    }

    private async Task BuildMappingAsync(string path, Dictionary<string, int>? map)
    {
        var file = TabularFile.Read(path, Sheet);
        Sheet = file.Sheet;
        HeaderRow ??= file.DetectHeaderRow(ImportFields.Sales.SelectMany(f => f.Keywords));
        var header = file.Header(HeaderRow.Value);
        bool fromProfile = false;
        if (map == null)
        {
            map = await importer.SavedMappingAsync(header);
            fromProfile = map != null;
            map ??= ImportFields.AutoMap(ImportFields.Sales, header);
        }
        Mapping = new MappingView
        {
            File = file, Token = Token!, OriginalName = uploads.OriginalName(Token!), HeaderRow = HeaderRow.Value,
            Fields = ImportFields.Sales, Map = map, FromSavedProfile = fromProfile,
        };
    }
}
