/* MALUNGGAY (ProductId 353): date its opening count to 2026-09-30 and post its held-back Epos Now till sales.
   Run once:  sqlcmd -S "BLANCHARD-PC\SQLEXPRESS" -E -C -d StoreInventoryDB -b -i sql\backdate-malunggay-opening-count.sql
   All-or-nothing: if the opening count isn't exactly as expected, nothing is changed. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
    -- 1. Opening count (movement 35: 0 -> 10, entered 2026-10-04 22:58 local) dated 2026-09-30 12:00 local.
    UPDATE dbo.StockMovements
    SET CreatedAt = '2026-09-30T16:00:00',
        Reference = N'Opening count dated 2026-09-30 (entered 2026-10-04 22:58)'
    WHERE MovementId = 35 AND ProductId = 353 AND MovementType = 'CYCLE_COUNT' AND QtyBefore = 0 AND QtyAfter = 10;
    IF @@ROWCOUNT <> 1 THROW 50001, 'Opening count not found as expected; nothing changed.', 1;

    -- 2. Post the till sales held back as BEFORE_COUNT, oldest day first (same rules as dbo.sp_ImportSalesHistory).
    DECLARE @day DATE, @qty DECIMAL(12,3), @on INT, @d INT, @st VARCHAR(12), @end DATETIME2(3);
    DECLARE c CURSOR LOCAL FAST_FORWARD FOR
        SELECT SaleDate, QtySold FROM dbo.SalesHistory WHERE ProductId = 353 AND PostStatus = 'BEFORE_COUNT' ORDER BY SaleDate;
    OPEN c; FETCH NEXT FROM c INTO @day, @qty;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        SET @end = DATEADD(HOUR, 4, CAST(DATEADD(DAY, 1, @day) AS DATETIME2(3)));  -- local midnight after the sales day (EDT = UTC-4)
        SELECT @on = OnHand FROM dbo.Inventory WITH (UPDLOCK, ROWLOCK) WHERE ProductId = 353;
        IF EXISTS (SELECT 1 FROM dbo.StockMovements WHERE ProductId = 353 AND MovementType = 'CYCLE_COUNT' AND CreatedAt >= @end)
            SELECT @d = 0, @st = 'BEFORE_COUNT';
        ELSE
        BEGIN
            SET @d = IIF(@qty > @on, @on, CAST(@qty AS INT));
            SET @st = IIF(@d < @qty, 'SHORT', 'POSTED');
            IF @d <> 0
            BEGIN
                UPDATE dbo.Inventory SET OnHand = @on - @d, UpdatedAt = SYSUTCDATETIME() WHERE ProductId = 353;  -- fires trg_CheckLowStock
                INSERT dbo.StockMovements (ProductId, MovementType, QtyDelta, QtyBefore, QtyAfter, UserId, Reference)
                VALUES (353, 'EPOS_SALE', -@d, @on, @on - @d, 1,
                        CONCAT(N'EPOS ', CONVERT(CHAR(10), @day, 23), IIF(@st = 'SHORT', CONCAT(N' · short ', CAST(@qty AS INT) - @d), N'')));
            END
        END
        UPDATE dbo.SalesHistory SET QtyPosted = @d, PostStatus = @st WHERE ProductId = 353 AND SaleDate = @day;
        FETCH NEXT FROM c INTO @day, @qty;
    END
    CLOSE c; DEALLOCATE c;
COMMIT;

-- Result
SELECT MovementId, MovementType, QtyDelta, QtyBefore, QtyAfter, CreatedAt, Reference FROM dbo.StockMovements WHERE ProductId = 353 ORDER BY MovementId;
SELECT SaleDate, QtySold, QtyPosted, PostStatus FROM dbo.SalesHistory WHERE ProductId = 353 ORDER BY SaleDate;
SELECT OnHand FROM dbo.Inventory WHERE ProductId = 353;
