# Installer-Gui.ps1 - the setup wizard of Install-IDevelop.ps1.
#
# A modern, Windows 11 style setup experience in ONE window:
#
#   Welcome  -> what is about to happen (install / update / repair), where it
#               goes, which version replaces which, plus an Options panel
#               (port, Start Menu shortcuts, open when finished).
#   License  -> the product licence with an explicit "I accept" gate.
#   Progress -> the Office-style creeping bar, step text and details log.
#   Finish   -> "You're all set" / rolled back / failed, with Open and Open log.
#
# Dot-sourced by the installer. The window runs on its own STA runspace
# (thread); the installer thread never touches it - it only writes to a
# synchronized hashtable ($Gui.Sync) that a 100 ms DispatcherTimer reads:
#   Step / StepName / Detail / Lines   -> "Step 3 of 7 - PostgreSQL", the last
#                                         message, the collapsible details log;
#   Done / Outcome / Summary           -> the finish page;
#   Consented / Cancelled              -> the Welcome/License gate;
#   Closed / OpenApp / OptPort / ...   -> what the person chose.
#
# Nothing here may break an installation: every entry point is wrapped, and a
# window that cannot start (no desktop, no WPF, RDP without session) simply
# leaves the console progress in charge.
#
# ASCII ONLY in this file: PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a
# typographic dash or quote becomes a parse error. Symbols are XAML entities.

$script:InstallerGuiScript = @'
try {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

    # ---- Theme -------------------------------------------------------------
    # Follow the system light/dark setting the way a Windows 11 dialog does.
    # Best effort: the installer is elevated, so this reads the ADMIN hive and
    # may differ from the signed-in user - light is the safe default.
    $dark = $false
    try {
        $p = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop
        $dark = ($p.AppsUseLightTheme -eq 0)
    } catch { $dark = $false }

    if ($dark) {
        $cWindow='#202020'; $cCard='#2B2B2B'; $cBorder='#3D3D3D'; $cText='#FFFFFF'
        $cSub='#C5C5C5'; $cMuted='#9B9B9B'; $cBtn='#333333'; $cBtnBorder='#4A4A4A'
        $cTrack='#3A3A3A'; $cLogBg='#252525'; $cBar='#2F2F2F'
    } else {
        $cWindow='#F3F3F3'; $cCard='#FFFFFF'; $cBorder='#E5E5E5'; $cText='#1B1B1B'
        $cSub='#3A3A3A'; $cMuted='#6B6B6B'; $cBtn='#FBFBFB'; $cBtnBorder='#D6D6D6'
        $cTrack='#E6E6E6'; $cLogBg='#F7F7F7'; $cBar='#EFEFEF'
    }
    # The brand accent stays the product's gold in both themes - it is the one
    # thing that should NOT follow the OS.
    $cAccent='#C9A227'; $cAccentDark='#AD8B1B'; $cOnAccent='#1B1B1B'

    [xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="$($sync.AppName) Setup" Width="700" Height="560" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" Background="$cWindow"
        FontFamily="Segoe UI Variable Text, Segoe UI" FontSize="14" Foreground="$cText"
        ShowInTaskbar="True" UseLayoutRounding="True" TextOptions.TextFormattingMode="Ideal">
  <Window.Resources>
    <!-- Windows 11 style command button: 4px radius, 1px border, quiet hover. -->
    <Style TargetType="Button">
      <Setter Property="Padding" Value="20,8"/>
      <Setter Property="Margin" Value="8,0,0,0"/>
      <Setter Property="MinWidth" Value="118"/>
      <Setter Property="MinHeight" Value="34"/>
      <Setter Property="Background" Value="$cBtn"/>
      <Setter Property="BorderBrush" Value="$cBtnBorder"/>
      <Setter Property="Foreground" Value="$cText"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="4" Padding="{TemplateBinding Padding}"
                    SnapsToDevicePixels="True">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.86"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.72"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="$cAccent"/>
      <Setter Property="BorderBrush" Value="$cAccentDark"/>
      <Setter Property="Foreground" Value="$cOnAccent"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="Link" TargetType="ToggleButton">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Foreground" Value="$cSub"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ToggleButton">
            <Border Background="Transparent" Padding="0,6">
              <TextBlock Text="{TemplateBinding Content}" TextDecorations="Underline" Foreground="{TemplateBinding Foreground}"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="CheckBox">
      <Setter Property="Foreground" Value="$cSub"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Margin" Value="0,6,0,0"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
    <!-- Card: the white surface a Windows 11 dialog puts its content on. -->
    <Style x:Key="Card" TargetType="Border">
      <Setter Property="Background" Value="$cCard"/>
      <Setter Property="BorderBrush" Value="$cBorder"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="8"/>
      <Setter Property="Padding" Value="26,22,26,22"/>
    </Style>
    <Style x:Key="H1" TargetType="TextBlock">
      <Setter Property="FontSize" Value="26"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="FontFamily" Value="Segoe UI Variable Display, Segoe UI"/>
      <Setter Property="Foreground" Value="$cText"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
    </Style>
    <Style x:Key="Body" TargetType="TextBlock">
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Foreground" Value="$cSub"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
      <Setter Property="LineHeight" Value="21"/>
    </Style>
    <Style x:Key="Caption" TargetType="TextBlock">
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Foreground" Value="$cMuted"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
    </Style>
  </Window.Resources>

  <Grid Margin="20,18,20,16">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- Header: product identity, always visible. -->
    <DockPanel Grid.Row="0" LastChildFill="True" Margin="6,0,6,14">
      <Border DockPanel.Dock="Left" Width="46" Height="46" CornerRadius="10" Background="#1B2A41" Margin="0,0,14,0">
        <Grid>
          <Image x:Name="BrandImg" Width="30" Height="30" Visibility="Collapsed"/>
          <TextBlock x:Name="BrandText" Text="ID" Foreground="$cAccent" FontWeight="Bold" FontSize="15"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Grid>
      </Border>
      <StackPanel VerticalAlignment="Center">
        <TextBlock x:Name="AppName" Text="IDevelop" FontSize="19" FontWeight="SemiBold"/>
        <TextBlock x:Name="AppVersion" Text="" Style="{StaticResource Caption}"/>
      </StackPanel>
    </DockPanel>

    <Border Grid.Row="1" Style="{StaticResource Card}">
      <Grid>
        <!-- ================= 1. WELCOME ================= -->
        <Grid x:Name="WelcomePage" Visibility="Collapsed">
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
          </Grid.RowDefinitions>
          <StackPanel Grid.Row="0">
            <TextBlock x:Name="WelcomeTitle" Text="Install IDevelop" Style="{StaticResource H1}"/>
            <TextBlock x:Name="WelcomeLead" Text="" Style="{StaticResource Body}" Margin="0,8,0,0"/>
          </StackPanel>
          <ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto" Margin="0,16,0,0">
            <StackPanel>
              <Border Background="$cBar" CornerRadius="6" Padding="14,12" Margin="0,0,0,14">
                <StackPanel>
                  <Grid Margin="0,0,0,6">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="150"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                    <TextBlock Text="Install location" Style="{StaticResource Caption}"/>
                    <TextBlock x:Name="SumPath" Grid.Column="1" Text="" FontSize="13" Foreground="$cSub" TextTrimming="CharacterEllipsis"/>
                  </Grid>
                  <Grid Margin="0,0,0,6">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="150"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                    <TextBlock Text="Version" Style="{StaticResource Caption}"/>
                    <TextBlock x:Name="SumVersion" Grid.Column="1" Text="" FontSize="13" Foreground="$cSub"/>
                  </Grid>
                  <Grid Margin="0,0,0,6">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="150"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                    <TextBlock Text="Database" Style="{StaticResource Caption}"/>
                    <TextBlock x:Name="SumDb" Grid.Column="1" Text="" FontSize="13" Foreground="$cSub"/>
                  </Grid>
                  <Grid>
                    <Grid.ColumnDefinitions><ColumnDefinition Width="150"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                    <TextBlock Text="Web address" Style="{StaticResource Caption}"/>
                    <TextBlock x:Name="SumUrl" Grid.Column="1" Text="" FontSize="13" Foreground="$cSub"/>
                  </Grid>
                </StackPanel>
              </Border>

              <TextBlock Text="What setup will do" FontSize="13" FontWeight="SemiBold" Foreground="$cText" Margin="0,0,0,6"/>
              <ItemsControl x:Name="StepsList">
                <ItemsControl.ItemTemplate>
                  <DataTemplate>
                    <Grid Margin="0,0,0,5">
                      <Grid.ColumnDefinitions><ColumnDefinition Width="18"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                      <TextBlock Text="&#x2022;" Foreground="$cAccent" FontSize="14"/>
                      <TextBlock Grid.Column="1" Text="{Binding}" FontSize="13" Foreground="$cSub" TextWrapping="Wrap"/>
                    </Grid>
                  </DataTemplate>
                </ItemsControl.ItemTemplate>
              </ItemsControl>

              <Expander x:Name="OptionsExpander" Header="Options" Margin="0,14,0,0" Foreground="$cSub" FontSize="13">
                <StackPanel Margin="4,10,0,0">
                  <CheckBox x:Name="OptShortcuts" Content="Create Start Menu shortcuts" IsChecked="True"/>
                  <CheckBox x:Name="OptFirewall" Content="Allow incoming connections on the app port (firewall rule)" IsChecked="True"/>
                  <CheckBox x:Name="OptOpenWhenDone" Content="Open IDevelop when setup finishes" IsChecked="True"/>
                  <TextBlock Text="The install location and database are set by this package and cannot be changed here."
                             Style="{StaticResource Caption}" Margin="0,10,0,0"/>
                </StackPanel>
              </Expander>
            </StackPanel>
          </ScrollViewer>
        </Grid>

        <!-- ================= 2. LICENSE ================= -->
        <Grid x:Name="LicensePage" Visibility="Collapsed">
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
          </Grid.RowDefinitions>
          <StackPanel Grid.Row="0" Margin="0,0,0,12">
            <TextBlock Text="License agreement" Style="{StaticResource H1}"/>
            <TextBlock Text="Please read the terms below before continuing." Style="{StaticResource Body}" Margin="0,6,0,0"/>
          </StackPanel>
          <Border Grid.Row="1" Background="$cLogBg" BorderBrush="$cBorder" BorderThickness="1" CornerRadius="6">
            <ScrollViewer VerticalScrollBarVisibility="Auto" Padding="14,12">
              <TextBlock x:Name="LicenseText" Text="" FontFamily="Consolas" FontSize="12" Foreground="$cSub" TextWrapping="Wrap"/>
            </ScrollViewer>
          </Border>
          <CheckBox x:Name="AcceptLicense" Grid.Row="2" Content="I accept the terms in the license agreement" Margin="0,12,0,0"/>
        </Grid>

        <!-- ================= 3. PROGRESS ================= -->
        <Grid x:Name="ProgressPage" Visibility="Collapsed">
          <Grid.RowDefinitions>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
          </Grid.RowDefinitions>
          <StackPanel Grid.Row="0" VerticalAlignment="Center">
            <TextBlock x:Name="Headline" Text="Installing IDevelop..." Style="{StaticResource H1}"/>
            <TextBlock x:Name="StepText" Text="Preparing..." Style="{StaticResource Body}" Margin="0,12,0,3"/>
            <TextBlock x:Name="DetailText" Text="" Style="{StaticResource Caption}" TextTrimming="CharacterEllipsis" Margin="0,0,0,20"/>
            <Grid>
              <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <ProgressBar x:Name="Bar" Height="6" Minimum="0" Maximum="100" Value="0" Foreground="$cAccent"
                           Background="$cTrack" BorderThickness="0" VerticalAlignment="Center"/>
              <TextBlock x:Name="PercentText" Grid.Column="1" Text="0%" Style="{StaticResource Caption}"
                         Margin="14,0,0,0" VerticalAlignment="Center" MinWidth="36" TextAlignment="Right"/>
            </Grid>
            <TextBlock Text="Please keep your computer on until setup completes." Style="{StaticResource Caption}" Margin="0,18,0,0"/>
          </StackPanel>
          <Border Grid.Row="1" x:Name="DetailsBox" Visibility="Collapsed" Background="$cLogBg" BorderBrush="$cBorder"
                  BorderThickness="1" CornerRadius="6" Margin="0,14,0,0">
            <TextBox x:Name="Details" Height="132" IsReadOnly="True" FontFamily="Consolas" FontSize="11"
                     Background="Transparent" Foreground="$cSub" BorderThickness="0" Padding="10,8"
                     VerticalScrollBarVisibility="Auto" TextWrapping="NoWrap"/>
          </Border>
        </Grid>

        <!-- ================= 4. FINISH ================= -->
        <Grid x:Name="ResultPage" Visibility="Collapsed">
          <StackPanel VerticalAlignment="Center">
            <TextBlock x:Name="ResultIcon" Text="&#x2714;" FontSize="46" Foreground="#16A34A" Margin="0,0,0,10"/>
            <TextBlock x:Name="ResultHeadline" Text="You're all set!" Style="{StaticResource H1}"/>
            <TextBlock x:Name="ResultText" Text="" Style="{StaticResource Body}" Margin="0,12,0,0"/>
            <TextBlock x:Name="Countdown" Text="" Style="{StaticResource Caption}" Margin="0,14,0,0"/>
          </StackPanel>
        </Grid>
      </Grid>
    </Border>

    <!-- Command bar -->
    <DockPanel Grid.Row="2" LastChildFill="False" Margin="6,14,6,0">
      <ToggleButton x:Name="DetailsToggle" DockPanel.Dock="Left" Content="Show details"
                    Style="{StaticResource Link}" Visibility="Collapsed"/>
      <!-- IsDefault/IsCancel: Enter runs the action from anywhere on the page
           (including from the licence checkbox) and Esc cancels, the way every
           Windows dialog behaves. -->
      <Button x:Name="CloseBtn" DockPanel.Dock="Right" Content="Close" IsEnabled="False" Visibility="Collapsed"/>
      <Button x:Name="NextBtn" DockPanel.Dock="Right" Content="Next" Style="{StaticResource Primary}" Visibility="Collapsed" IsDefault="True"/>
      <Button x:Name="OpenBtn" DockPanel.Dock="Right" Content="Open IDevelop" Style="{StaticResource Primary}" Visibility="Collapsed"/>
      <Button x:Name="LogBtn" DockPanel.Dock="Right" Content="Open log" Visibility="Collapsed"/>
      <Button x:Name="BackBtn" DockPanel.Dock="Right" Content="Back" Visibility="Collapsed"/>
      <Button x:Name="CancelBtn" DockPanel.Dock="Right" Content="Cancel" Visibility="Collapsed" IsCancel="True"/>
    </DockPanel>
  </Grid>
</Window>
"@
    $reader = New-Object System.Xml.XmlNodeReader $xaml
    $win = [Windows.Markup.XamlReader]::Load($reader)
    $ui = @{}
    foreach ($n in 'BrandImg','BrandText','AppName','AppVersion',
                   'WelcomePage','WelcomeTitle','WelcomeLead','SumPath','SumVersion','SumDb','SumUrl','StepsList',
                   'OptionsExpander','OptShortcuts','OptFirewall','OptOpenWhenDone',
                   'LicensePage','LicenseText','AcceptLicense',
                   'ProgressPage','Headline','StepText','DetailText','Bar','PercentText','Details','DetailsBox',
                   'ResultPage','ResultIcon','ResultHeadline','ResultText','Countdown',
                   'DetailsToggle','CloseBtn','NextBtn','OpenBtn','LogBtn','BackBtn','CancelBtn') {
        $ui[$n] = $win.FindName($n)
    }

    $ui.AppName.Text = $sync.AppName
    $ui.AppVersion.Text = if ($sync.Version) { 'Version ' + $sync.Version + '  |  ' + $sync.Publisher } else { [string]$sync.Publisher }
    $win.Title = $sync.AppName + ' Setup'
    # The header tile always reads "ID" - that wordmark IS the brand here. The
    # packaged .ico is used only for the title bar and the taskbar, where
    # Windows wants a real icon.
    if ($sync.IconPath -and (Test-Path $sync.IconPath)) {
        try { $win.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create((New-Object System.Uri $sync.IconPath)) } catch {}
    }

    $state = @{ pct = 0.0; lines = 0; ended = $false; countdownAt = $null; page = '' }

    # ---- Page router -------------------------------------------------------
    $show = {
        param($page)
        $state.page = $page
        foreach ($p in 'WelcomePage','LicensePage','ProgressPage','ResultPage') { $ui[$p].Visibility = 'Collapsed' }
        foreach ($b in 'CloseBtn','NextBtn','OpenBtn','LogBtn','BackBtn','CancelBtn','DetailsToggle') { $ui[$b].Visibility = 'Collapsed' }
        switch ($page) {
            'welcome' {
                $ui.WelcomePage.Visibility = 'Visible'
                $ui.NextBtn.Content = if ($sync.HasLicense) { 'Next' } else { $sync.ActionVerb }
                $ui.NextBtn.Visibility = 'Visible'
                $ui.CancelBtn.Visibility = 'Visible'
                $ui.NextBtn.Focus() | Out-Null
            }
            'license' {
                $ui.LicensePage.Visibility = 'Visible'
                $ui.NextBtn.Content = $sync.ActionVerb
                $ui.NextBtn.IsEnabled = [bool]$ui.AcceptLicense.IsChecked
                $ui.NextBtn.Visibility = 'Visible'
                $ui.BackBtn.Visibility = 'Visible'
                $ui.CancelBtn.Visibility = 'Visible'
            }
            'progress' {
                $ui.ProgressPage.Visibility = 'Visible'
                $ui.DetailsToggle.Visibility = 'Visible'
                $ui.CloseBtn.Visibility = 'Visible'
                $ui.CloseBtn.IsEnabled = $false
            }
            'result' {
                $ui.ResultPage.Visibility = 'Visible'
                $ui.DetailsToggle.Visibility = 'Visible'
                $ui.CloseBtn.Visibility = 'Visible'
                $ui.CloseBtn.IsEnabled = $true
            }
        }
    }

    # ---- Welcome content ---------------------------------------------------
    $ui.WelcomeTitle.Text = [string]$sync.WelcomeTitle
    $ui.WelcomeLead.Text  = [string]$sync.WelcomeLead
    $ui.SumPath.Text      = [string]$sync.InstallDir
    $ui.SumVersion.Text   = [string]$sync.VersionLine
    $ui.SumDb.Text        = [string]$sync.DbLine
    $ui.SumUrl.Text       = [string]$sync.AppUrlPlanned
    $ui.StepsList.ItemsSource = @($sync.PlanSteps)
    if ($sync.HasLicense) { $ui.LicenseText.Text = [string]$sync.LicenseBody }

    $ui.AcceptLicense.Add_Checked({ $ui.NextBtn.IsEnabled = $true })
    $ui.AcceptLicense.Add_Unchecked({ $ui.NextBtn.IsEnabled = $false })

    $ui.NextBtn.Add_Click({
        if ($state.page -eq 'welcome') {
            $sync.OptShortcuts = [bool]$ui.OptShortcuts.IsChecked
            $sync.OptFirewall = [bool]$ui.OptFirewall.IsChecked
            $sync.OptOpenWhenDone = [bool]$ui.OptOpenWhenDone.IsChecked
            if ($sync.HasLicense) { & $show 'license'; return }
            $sync.Consented = $true; & $show 'progress'; return
        }
        if ($state.page -eq 'license') {
            if (-not $ui.AcceptLicense.IsChecked) { return }
            $sync.Consented = $true; & $show 'progress'
        }
    })
    $ui.BackBtn.Add_Click({ if ($state.page -eq 'license') { & $show 'welcome' } })
    $ui.CancelBtn.Add_Click({ $sync.Cancelled = $true; $sync.Closed = $true; $win.Close() })

    $ui.DetailsToggle.Add_Click({
        if ($ui.DetailsBox.Visibility -eq 'Visible') { $ui.DetailsBox.Visibility = 'Collapsed'; $ui.DetailsToggle.Content = 'Show details' }
        else {
            # The log lives on the progress page; showing it from the finish
            # page means showing that page's box too.
            $ui.DetailsBox.Visibility = 'Visible'; $ui.DetailsToggle.Content = 'Hide details'
            if ($state.page -eq 'result') { $ui.ProgressPage.Visibility = 'Visible'; $ui.ResultPage.Visibility = 'Collapsed' }
            $ui.Details.ScrollToEnd()
        }
        if ($ui.DetailsBox.Visibility -eq 'Collapsed' -and $sync.Done) {
            $ui.ProgressPage.Visibility = 'Collapsed'; $ui.ResultPage.Visibility = 'Visible'
        }
    })
    $ui.CloseBtn.Add_Click({ $sync.Closed = $true; $win.Close() })
    $ui.OpenBtn.Add_Click({ $sync.OpenApp = $true; $sync.Closed = $true; $win.Close() })
    $ui.LogBtn.Add_Click({ try { if ($sync.LogFile) { Start-Process notepad.exe -ArgumentList ('"' + $sync.LogFile + '"') } } catch {} })
    $win.Add_Closing({
        param($s, $e)
        # No closing mid-install: the bar is the only thing telling the person
        # the machine is busy. Before it starts, closing is a cancel.
        if ($state.page -in 'welcome','license') { $sync.Cancelled = $true; $sync.Closed = $true; return }
        if (-not $sync.Done) { $e.Cancel = $true } else { $sync.Closed = $true }
    })

    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(100)
    $timer.Add_Tick({
        try {
            # Details log: append only the new lines.
            $count = $sync.Lines.Count
            if ($count -gt $state.lines) {
                $sb = New-Object System.Text.StringBuilder
                for ($i = $state.lines; $i -lt $count; $i++) { [void]$sb.AppendLine([string]$sync.Lines[$i]) }
                $state.lines = $count
                $ui.Details.AppendText($sb.ToString())
                if ($ui.DetailsBox.Visibility -eq 'Visible') { $ui.Details.ScrollToEnd() }
            }
            if ($state.page -in 'welcome','license') { return }

            if (-not $sync.Done) {
                $ui.Headline.Text = $sync.Headline
                $total = [Math]::Max(1, [int]$sync.TotalSteps)
                $step = [int]$sync.Step
                if ($step -gt 0) {
                    $ui.StepText.Text = 'Step {0} of {1} - {2}' -f $step, $total, $sync.StepName
                    $floor = (($step - 1) / [double]$total) * 100.0
                    $ceil  = ($step / [double]$total) * 100.0
                } else {
                    $ui.StepText.Text = 'Preparing...'
                    $floor = 0.0; $ceil = 4.0
                }
                if ($state.pct -lt $floor) { $state.pct = $floor }
                # Creep toward (but never reach) the next boundary - visible
                # motion during a long step, a jump when the step really ends.
                $state.pct += (($ceil - 0.8) - $state.pct) * 0.012
                $ui.DetailText.Text = [string]$sync.Detail
                $ui.Bar.Value = $state.pct
                $ui.PercentText.Text = ('{0}%' -f [int][Math]::Floor($state.pct))
            } elseif (-not $state.ended) {
                # Finish the bar, then switch to the finish page.
                $state.pct += (100.0 - $state.pct) * 0.35
                $ui.Bar.Value = $state.pct
                $ui.PercentText.Text = ('{0}%' -f [int][Math]::Floor($state.pct))
                if ($state.pct -ge 99.6) {
                    $ui.Bar.Value = 100; $ui.PercentText.Text = '100%'
                    $state.ended = $true
                    & $show 'result'
                    switch ($sync.Outcome) {
                        'success' {
                            $ui.ResultIcon.Text = [string][char]0x2714; $ui.ResultIcon.Foreground = '#16A34A'
                            $ui.ResultHeadline.Text = "You're all set!"
                            if ($sync.OptOpenWhenDone) { $ui.OpenBtn.Visibility = 'Visible'; $ui.OpenBtn.Focus() | Out-Null }
                            $ui.LogBtn.Visibility = 'Visible'
                        }
                        'rolledback' {
                            $ui.ResultIcon.Text = [string][char]0x26A0; $ui.ResultIcon.Foreground = '#D97706'
                            $ui.ResultHeadline.Text = 'Update failed - previous version restored'
                            $ui.LogBtn.Visibility = 'Visible'
                        }
                        default {
                            $ui.ResultIcon.Text = [string][char]0x2716; $ui.ResultIcon.Foreground = '#DC2626'
                            $ui.ResultHeadline.Text = 'Something went wrong'
                            $ui.LogBtn.Visibility = 'Visible'
                        }
                    }
                    $ui.ResultText.Text = (@($sync.Summary) -join [Environment]::NewLine)
                    if ([int]$sync.AutoClose -gt 0) { $state.countdownAt = (Get-Date).AddSeconds([int]$sync.AutoClose) }
                }
            } elseif ($state.countdownAt) {
                $left = [int][Math]::Ceiling(($state.countdownAt - (Get-Date)).TotalSeconds)
                if ($left -le 0) { $sync.Closed = $true; $win.Close() }
                else { $ui.Countdown.Text = ('This window closes in {0} s.' -f $left) }
            }
        } catch { }
    })
    $win.Add_Loaded({
        # Screen position in PHYSICAL pixels (WPF units are DPI-independent),
        # for the installer's own screenshot-based checks.
        try {
            $m = [System.Windows.PresentationSource]::FromVisual($win).CompositionTarget.TransformToDevice
            $sync.Bounds = @([int]($win.Left * $m.M11), [int]($win.Top * $m.M22), [int]($win.ActualWidth * $m.M11), [int]($win.ActualHeight * $m.M22))
        } catch {}
        if ($sync.ShowWelcome) { & $show 'welcome' } else { $sync.Consented = $true; & $show 'progress' }
        $sync.Ready = $true; $timer.Start()
    })
    $win.Add_Closed({ $timer.Stop(); $sync.Closed = $true })
    $win.ShowDialog() | Out-Null
} catch {
    $sync.Error = $_.Exception.Message
    $sync.Closed = $true
}
'@

<#
.SYNOPSIS Ask what to do on a machine that already has the product. Returns the chosen action id, or '' when cancelled.
.DESCRIPTION
    The maintenance page a Windows setup shows when the product is already
    installed. Every operation the package supports is offered here, so nobody
    has to know that Setup.bat, Manage-IDevelop.ps1 and
    Uninstall-IDevelop.ps1 exist:

      update      code + pending database migrations (recommended)
      filesonly   application files only (refused if a migration is pending)
      repair      re-deploy over the top and restart the service
      reinstall   fresh database from the packaged snapshot (destructive)
      backup      take a restore point now
      restore     roll back to a restore point
      checkdb     database connectivity and schema check
      adminpw     reset the application admin password
      pgpw        set the stored PostgreSQL password
      listpoints  list restore points
      uninstall   remove the product

    The console menu is deliberately NOT one of them. Everything a user can
    reach goes through this window; Setup.bat is a rescue path for machines
    where no window can open, not a choice offered here.

    Actions marked destructive are visually flagged and never pre-selected.
.PARAMETER Mode
    'setup' (default) is the list above, shown from inside the setup package.

    'servicing' is the SAME window opened from Windows itself - the Modify
    button in Apps & features, which runs the copy kept under
    <InstallDir>\maintenance. That copy has no application payload, so the four
    actions that need one (update, filesonly, repair, reinstall) are removed
    rather than offered and then failed. What is left is exactly what a
    servicing copy can honestly do: back up, restore, list restore points,
    check the database, reset the two passwords, uninstall.
#>
function Show-SetupChooser {
    param(
        [string]$AppName = 'IDevelop',
        [string]$InstalledVersion = '',
        [string]$PackageVersion = '',
        [string]$InstallDir = '',
        [string]$IconPath = '',
        [string]$Publisher = '',
        [ValidateSet('setup', 'servicing')][string]$Mode = 'setup'
    )
    $sync = [hashtable]::Synchronized(@{
        AppName = $AppName; InstalledVersion = $InstalledVersion; PackageVersion = $PackageVersion
        InstallDir = $InstallDir; IconPath = $IconPath; Publisher = $Publisher; Mode = $Mode
        Action = ''; Ready = $false; Error = ''
    })
    $script = @'
try {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
    $dark = $false
    try { $dark = ((Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme -eq 0) } catch {}
    if ($dark) { $cWindow='#202020'; $cCard='#2B2B2B'; $cBorder='#3D3D3D'; $cText='#FFFFFF'; $cSub='#C5C5C5'; $cMuted='#9B9B9B'; $cBtn='#333333'; $cBtnBorder='#4A4A4A'; $cHover='#343434' }
    else { $cWindow='#F3F3F3'; $cCard='#FFFFFF'; $cBorder='#E5E5E5'; $cText='#1B1B1B'; $cSub='#3A3A3A'; $cMuted='#6B6B6B'; $cBtn='#FBFBFB'; $cBtnBorder='#D6D6D6'; $cHover='#F5F5F5' }
    $cAccent='#C9A227'; $cAccentDark='#AD8B1B'; $cOnAccent='#1B1B1B'

    # One row per action. Tag carries the id the caller dispatches on.
    $rows = @(
        @{ id='update';     t='Update to version ' + $sync.PackageVersion; d='Refresh the application and apply any pending database changes. Your data is preserved.'; g='Recommended'; danger=$false },
        @{ id='filesonly';  t='Update application files only';   d='Replace the program files and restart the service. Refused if this package carries a database change the installed version has not applied.'; g='Recommended'; danger=$false },
        @{ id='repair';     t='Repair this installation';        d='Re-deploy the current version over the top, re-register the service and restart it.'; g='Recommended'; danger=$false },
        @{ id='backup';     t='Back up now';                     d='Take a restore point (program files + database) before you change anything.'; g='Data'; danger=$false },
        @{ id='restore';    t='Restore a previous version';      d='Roll the program files and the database back to a restore point.'; g='Data'; danger=$true },
        @{ id='listpoints'; t='List restore points';             d='Show the restore points kept on this computer.'; g='Data'; danger=$false },
        @{ id='checkdb';    t='Check the database';              d='Verify connectivity, schema version and that nothing is pending.'; g='Tools'; danger=$false },
        @{ id='adminpw';    t='Reset the admin password';        d='Set the application administrator password back to the standard one.'; g='Tools'; danger=$false },
        @{ id='pgpw';       t='Set the PostgreSQL password';     d='Store the postgres superuser password this package should use.'; g='Tools'; danger=$false },
        @{ id='reinstall';  t='Reinstall from scratch';          d='Replace the database with the one packaged in this installer. ALL current data is lost.'; g='Remove and replace'; danger=$true },
        @{ id='uninstall';  t='Uninstall ' + $sync.AppName;      d='Remove the service, the program files, the shortcuts and the Apps & features entry.'; g='Remove and replace'; danger=$true }
    )

    # Servicing copy: no application payload, so anything that would deploy code
    # is dropped. Offering a button that cannot work is worse than not offering
    # it - the operator is told where those actions live instead.
    if ($sync.Mode -eq 'servicing') {
        $rows = $rows | Where-Object { $_.id -notin @('update', 'filesonly', 'repair', 'reinstall') }
    }

    [xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="$($sync.AppName) Setup" Width="700" Height="620" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" Background="$cWindow"
        FontFamily="Segoe UI Variable Text, Segoe UI" FontSize="14" Foreground="$cText" UseLayoutRounding="True">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Padding" Value="20,8"/><Setter Property="Margin" Value="8,0,0,0"/>
      <Setter Property="MinWidth" Value="118"/><Setter Property="MinHeight" Value="34"/>
      <Setter Property="Background" Value="$cBtn"/><Setter Property="BorderBrush" Value="$cBtnBorder"/>
      <Setter Property="Foreground" Value="$cText"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border x:Name="b" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                  BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="4" Padding="{TemplateBinding Padding}">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.86"/></Trigger>
            <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.45"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="$cAccent"/><Setter Property="BorderBrush" Value="$cAccentDark"/>
      <Setter Property="Foreground" Value="$cOnAccent"/><Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <!-- Selectable action card: the Windows 11 settings-row pattern. -->
    <Style TargetType="RadioButton">
      <Setter Property="Margin" Value="0,0,0,8"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="RadioButton">
          <Border x:Name="b" Background="$cCard" BorderBrush="$cBorder" BorderThickness="1" CornerRadius="6" Padding="14,11">
            <Grid>
              <Grid.ColumnDefinitions><ColumnDefinition Width="26"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Ellipse x:Name="dot" Width="15" Height="15" Stroke="$cBtnBorder" StrokeThickness="1.5" VerticalAlignment="Top" Margin="0,2,0,0"/>
              <Ellipse x:Name="fill" Width="7" Height="7" Fill="$cAccent" VerticalAlignment="Top" Margin="4,6,0,0" HorizontalAlignment="Left" Visibility="Collapsed"/>
              <ContentPresenter Grid.Column="1"/>
            </Grid>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsChecked" Value="True">
              <Setter TargetName="b" Property="BorderBrush" Value="$cAccent"/>
              <Setter TargetName="b" Property="BorderThickness" Value="2"/>
              <Setter TargetName="dot" Property="Stroke" Value="$cAccent"/>
              <Setter TargetName="fill" Property="Visibility" Value="Visible"/>
            </Trigger>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="$cHover"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Grid Margin="20,18,20,16">
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>

    <DockPanel Grid.Row="0" Margin="6,0,6,14">
      <Border DockPanel.Dock="Left" Width="46" Height="46" CornerRadius="10" Background="#1B2A41" Margin="0,0,14,0">
        <Grid>
          <Image x:Name="BrandImg" Width="30" Height="30" Visibility="Collapsed"/>
          <TextBlock x:Name="BrandText" Text="ID" Foreground="$cAccent" FontWeight="Bold" FontSize="15" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Grid>
      </Border>
      <StackPanel VerticalAlignment="Center">
        <TextBlock x:Name="AppName" Text="IDevelop" FontSize="19" FontWeight="SemiBold"/>
        <TextBlock x:Name="Sub" Text="" FontSize="12" Foreground="$cMuted"/>
      </StackPanel>
    </DockPanel>

    <StackPanel Grid.Row="1" Margin="6,0,6,12">
      <TextBlock Text="What would you like to do?" FontSize="26" FontWeight="SemiBold"
                 FontFamily="Segoe UI Variable Display, Segoe UI" Foreground="$cText"/>
      <TextBlock x:Name="Lead" Text="" FontSize="14" Foreground="$cSub" TextWrapping="Wrap" Margin="0,6,0,0"/>
    </StackPanel>

    <ScrollViewer Grid.Row="2" VerticalScrollBarVisibility="Auto" Margin="6,0,6,0">
      <StackPanel x:Name="Actions"/>
    </ScrollViewer>

    <DockPanel Grid.Row="3" LastChildFill="False" Margin="6,14,6,0">
      <Button x:Name="GoBtn" DockPanel.Dock="Right" Content="Continue" Style="{StaticResource Primary}" IsDefault="True"/>
      <Button x:Name="CancelBtn" DockPanel.Dock="Right" Content="Cancel" IsCancel="True"/>
    </DockPanel>
  </Grid>
</Window>
"@
    $reader = New-Object System.Xml.XmlNodeReader $xaml
    $win = [Windows.Markup.XamlReader]::Load($reader)
    $ui = @{}
    foreach ($n in 'BrandImg','BrandText','AppName','Sub','Lead','Actions','GoBtn','CancelBtn') { $ui[$n] = $win.FindName($n) }
    $ui.AppName.Text = $sync.AppName
    $ui.Sub.Text = 'Version ' + $sync.InstalledVersion + ' is installed  |  ' + $sync.InstallDir
    $ui.Lead.Text = if ($sync.Mode -eq 'servicing') {
        # Says plainly why update and reinstall are not on this list, so nobody
        # concludes the product cannot be updated.
        'Maintenance for the installed copy. To update, repair or reinstall ' + $sync.AppName +
        ', run the setup package for the version you want.'
    } elseif ($sync.InstalledVersion -eq $sync.PackageVersion) {
        'This computer already runs version ' + $sync.PackageVersion + '. Choose an action below.'
    } else {
        $sync.AppName + ' ' + $sync.InstalledVersion + ' is installed and this package contains version ' + $sync.PackageVersion + '.'
    }
    # Title bar / taskbar only - the header tile keeps the "ID" wordmark.
    if ($sync.IconPath -and (Test-Path $sync.IconPath)) {
        try { $win.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create((New-Object System.Uri $sync.IconPath)) } catch {}
    }

    # Build the list, grouped, with the group name as a quiet heading.
    $panel = $ui.Actions
    $lastGroup = ''
    $first = $true
    foreach ($r in $rows) {
        if ($r.g -ne $lastGroup) {
            $h = New-Object System.Windows.Controls.TextBlock
            $h.Text = $r.g.ToUpper()
            $h.FontSize = 11; $h.FontWeight = 'SemiBold'
            $h.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#8A8A8A')
            $h.Margin = New-Object System.Windows.Thickness(2, $(if ($lastGroup) { 12 } else { 0 }), 0, 6)
            [void]$panel.Children.Add($h)
            $lastGroup = $r.g
        }
        $rb = New-Object System.Windows.Controls.RadioButton
        $rb.GroupName = 'act'
        $rb.Tag = $r.id
        $sp = New-Object System.Windows.Controls.StackPanel
        $t1 = New-Object System.Windows.Controls.TextBlock
        $t1.Text = $r.t; $t1.FontSize = 14; $t1.FontWeight = 'SemiBold'; $t1.TextWrapping = 'Wrap'
        $t1.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($(if ($r.danger) { '#C2410C' } else { '__TEXT__' }))
        $t2 = New-Object System.Windows.Controls.TextBlock
        $t2.Text = $r.d; $t2.FontSize = 12; $t2.TextWrapping = 'Wrap'; $t2.Margin = New-Object System.Windows.Thickness(0,2,0,0)
        $t2.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('__MUTED__')
        [void]$sp.Children.Add($t1); [void]$sp.Children.Add($t2)
        $rb.Content = $sp
        if ($first) { $rb.IsChecked = $true; $first = $false }
        [void]$panel.Children.Add($rb)
    }

    $ui.GoBtn.Add_Click({
        foreach ($c in $panel.Children) {
            if ($c -is [System.Windows.Controls.RadioButton] -and $c.IsChecked) { $sync.Action = [string]$c.Tag; break }
        }
        $win.Close()
    })
    $ui.CancelBtn.Add_Click({ $sync.Action = ''; $win.Close() })
    $win.Add_Loaded({ $sync.Ready = $true })
    $win.ShowDialog() | Out-Null
} catch {
    $sync.Error = $_.Exception.Message
}
'@
    # The two colours the row template cannot inherit are substituted here so the
    # chooser follows the same light/dark palette as the wizard.
    $darkNow = $false
    try { $darkNow = ((Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme -eq 0) } catch {}
    $script = $script.Replace('__TEXT__', $(if ($darkNow) { '#FFFFFF' } else { '#1B1B1B' }))
    $script = $script.Replace('__MUTED__', $(if ($darkNow) { '#9B9B9B' } else { '#6B6B6B' }))

    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'; $rs.ThreadOptions = 'ReuseThread'; $rs.Open()
    $rs.SessionStateProxy.SetVariable('sync', $sync)
    $ps = [powershell]::Create(); $ps.Runspace = $rs
    [void]$ps.AddScript($script)
    $ps.Invoke() | Out-Null
    $err = $sync.Error
    try { $ps.Dispose(); $rs.Dispose() } catch {}
    if ($err) { throw ('setup chooser: ' + $err) }
    return [string]$sync.Action
}

<#
.SYNOPSIS Open the setup window. Returns a handle for Update/Complete/Wait, or throws (caller falls back to the console).
.DESCRIPTION
    With -ShowWelcome the window opens on the Welcome page (and the License page
    when a licence file is supplied) and waits for the person to choose; the
    caller MUST then call Wait-InstallerConsent before doing any work. Without
    it the window behaves exactly as the old progress-only window did, which is
    what every unattended/parameterised call still gets.
#>
function Start-InstallerGui {
    param(
        [string]$AppName = 'IDevelop',
        [string]$Version = '',
        [string]$Publisher = '',
        [string]$Headline = 'Installing IDevelop...',
        [int]$TotalSteps = 7,
        [int]$AutoCloseSeconds = 0,
        [string]$IconPath = '',
        [switch]$ShowWelcome,
        [string]$ActionVerb = 'Install',
        [string]$WelcomeTitle = '',
        [string]$WelcomeLead = '',
        [string]$InstallDir = '',
        [string]$VersionLine = '',
        [string]$DbLine = '',
        [string]$AppUrlPlanned = '',
        [string[]]$PlanSteps = @(),
        [string]$LicenseBody = ''
    )
    $sync = [hashtable]::Synchronized(@{
        AppName = $AppName; Version = $Version; Publisher = $Publisher; Headline = $Headline
        TotalSteps = $TotalSteps; IconPath = $IconPath
        Step = 0; StepName = 'Preparing'; Detail = ''
        Lines = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
        Done = $false; Success = $false; Outcome = ''; Summary = @()
        AppUrl = ''; LogFile = ''; SummaryFile = ''
        AutoClose = $AutoCloseSeconds; Closed = $false; OpenApp = $false; Ready = $false; Error = ''
        # Wizard
        ShowWelcome = [bool]$ShowWelcome; ActionVerb = $ActionVerb
        WelcomeTitle = $WelcomeTitle; WelcomeLead = $WelcomeLead
        InstallDir = $InstallDir; VersionLine = $VersionLine; DbLine = $DbLine
        AppUrlPlanned = $AppUrlPlanned; PlanSteps = @($PlanSteps)
        HasLicense = [bool]$LicenseBody; LicenseBody = $LicenseBody
        Consented = $false; Cancelled = $false
        OptShortcuts = $true; OptFirewall = $true; OptOpenWhenDone = $true
    })
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'
    $rs.ThreadOptions = 'ReuseThread'
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('sync', $sync)
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script:InstallerGuiScript)
    $handle = $ps.BeginInvoke()
    $waited = 0
    while (-not $sync.Ready -and -not $sync.Error -and $waited -lt 80) { Start-Sleep -Milliseconds 100; $waited++ }
    if ($sync.Error) { try { $ps.Dispose(); $rs.Dispose() } catch {}; throw ('setup window: ' + $sync.Error) }
    if (-not $sync.Ready) { try { $ps.Stop(); $ps.Dispose(); $rs.Dispose() } catch {}; throw 'setup window did not open in time' }
    return @{ Sync = $sync; PowerShell = $ps; Runspace = $rs; Handle = $handle }
}

<#
.SYNOPSIS Block until the person presses Install (returns $true) or Cancel / closes the window (returns $false).
.DESCRIPTION
    Only meaningful for a window opened with -ShowWelcome; any other window has
    already consented, so this returns $true immediately.
#>
function Wait-InstallerConsent {
    param($Gui)
    if (-not $Gui) { return $true }
    try {
        while (-not $Gui.Sync.Consented -and -not $Gui.Sync.Cancelled -and -not $Gui.Sync.Closed) {
            Start-Sleep -Milliseconds 150
        }
        return [bool]$Gui.Sync.Consented
    } catch { return $true }
}

<#
.SYNOPSIS Show the finish page. Outcome: success | rolledback | failed. Summary: lines shown under the headline.
#>
function Complete-InstallerGui {
    param($Gui, [string]$Outcome, [string[]]$Summary, [string]$AppUrl = '', [string]$LogFile = '', [string]$SummaryFile = '')
    if (-not $Gui) { return }
    try {
        $Gui.Sync.Outcome = $Outcome
        $Gui.Sync.Success = ($Outcome -eq 'success')
        $Gui.Sync.Summary = @($Summary)
        $Gui.Sync.AppUrl = $AppUrl
        $Gui.Sync.LogFile = $LogFile
        $Gui.Sync.SummaryFile = $SummaryFile
        $Gui.Sync.Done = $true
    } catch {}
}

<#
.SYNOPSIS Block until the person closes the window (or the countdown ends); returns $true when "Open IDevelop" was chosen.
#>
function Wait-InstallerGui {
    param($Gui, [int]$MaxSeconds = 0)
    if (-not $Gui) { return $false }
    $deadline = if ($MaxSeconds -gt 0) { (Get-Date).AddSeconds($MaxSeconds) } else { $null }
    try {
        while (-not $Gui.Sync.Closed) {
            if ($deadline -and (Get-Date) -gt $deadline) { break }
            Start-Sleep -Milliseconds 200
        }
    } catch {}
    try { $Gui.PowerShell.Stop() } catch {}
    try { $Gui.PowerShell.Dispose(); $Gui.Runspace.Dispose() } catch {}
    return [bool]$Gui.Sync.OpenApp
}
