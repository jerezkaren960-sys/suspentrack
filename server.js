// ============================================
// SUSPENTRACK - SERVIDOR CON POSTGRESQL
// ============================================

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// SIMULADOR - USUARIO SIEMPRE LOGUEADO
// ============================================
app.use((req, res, next) => {
    req.usuario = { id: 1, nombre: 'Administrador', rol: 'ADMIN' };
    next();
});

// ============================================
// REDIRIGIR RAÍZ AL DASHBOARD
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============================================
// CONEXIÓN A POSTGRESQL
// ============================================
const pool = new Pool({
    connectionString: 'postgresql://suspentrack_db_user:ucsZVGVCNBMG2XEeLn4dkizU6WEI1ecL@dpg-d8jsj29kh4rs73egss80-a/suspentrack_db',
    ssl: { rejectUnauthorized: false }
});

app.locals.pool = pool;

// ============================================
// CREAR TABLAS AUTOMÁTICAMENTE
// ============================================
async function crearTablas() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios(
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(100) NOT NULL,
                correo VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                rol VARCHAR(20) NOT NULL,
                estado VARCHAR(20) DEFAULT 'ACTIVO',
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS vehiculos(
                id SERIAL PRIMARY KEY,
                placa VARCHAR(10) UNIQUE NOT NULL,
                marca VARCHAR(50) NOT NULL,
                modelo VARCHAR(50) NOT NULL,
                anio INT,
                kilometraje INT DEFAULT 0,
                capacidad_carga DECIMAL(10,2),
                frecuencia_uso VARCHAR(10) DEFAULT 'MEDIA',
                estado_general VARCHAR(20) DEFAULT 'OPERATIVO',
                criticidad VARCHAR(20) DEFAULT 'NO EVALUADO',
                ultimo_mantenimiento DATE,
                fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS componentes(
                id SERIAL PRIMARY KEY,
                vehiculo_id INT NOT NULL,
                nombre VARCHAR(30) NOT NULL,
                estado VARCHAR(10) DEFAULT 'BUENO',
                fecha_inspeccion DATE,
                observaciones TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS inspecciones(
                id SERIAL PRIMARY KEY,
                vehiculo_id INT NOT NULL,
                tecnico_id INT NOT NULL,
                fecha DATE NOT NULL,
                kilometraje INT DEFAULT 0,
                observaciones TEXT,
                evidencia VARCHAR(500)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS mantenimientos(
                id SERIAL PRIMARY KEY,
                vehiculo_id INT NOT NULL,
                tecnico_id INT NOT NULL,
                tipo VARCHAR(20) NOT NULL,
                fecha DATE NOT NULL,
                costo DECIMAL(10,2) DEFAULT 0,
                descripcion TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS alertas(
                id SERIAL PRIMARY KEY,
                vehiculo_id INT NOT NULL,
                nivel VARCHAR(10) NOT NULL,
                mensaje TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS priorizaciones(
                id SERIAL PRIMARY KEY,
                vehiculo_id INT NOT NULL,
                kilometraje_puntos INT DEFAULT 0,
                mantenimiento_puntos INT DEFAULT 0,
                fallas_puntos INT DEFAULT 0,
                componentes_puntos INT DEFAULT 0,
                uso_puntos INT DEFAULT 0,
                puntaje_total INT DEFAULT 0,
                clasificacion VARCHAR(10),
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            INSERT INTO usuarios (nombre, correo, password, rol, estado) 
            SELECT 'Administrador', 'admin@suspentrack.com', '$2a$10$N9qo8uLOickgx2ZMRZoMy.MrJ5qTqC8q8q8q8q8q8q8q8q8q8q', 'ADMIN', 'ACTIVO'
            WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE correo = 'admin@suspentrack.com')
        `);

        await pool.query(`
            INSERT INTO vehiculos (placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general)
            SELECT 'ABC-123', 'Chevrolet', 'NPR', 2020, 85000, 3500, 'ALTA', 'OPERATIVO'
            WHERE NOT EXISTS (SELECT 1 FROM vehiculos WHERE placa = 'ABC-123')
        `);

        console.log('✅ Tablas creadas/verificadas correctamente');
    } catch (error) {
        console.error('❌ Error creando tablas:', error.message);
    }
}

// Ejecutar creación de tablas
crearTablas();

// ============================================
// ALGORITMO DE PRIORIZACIÓN
// ============================================
async function calcularCriticidad(vehiculoId, client) {
    const { rows: vehiculo } = await client.query(
        'SELECT kilometraje, frecuencia_uso, ultimo_mantenimiento FROM vehiculos WHERE id = $1',
        [vehiculoId]
    );

    if (vehiculo.length === 0) return null;

    let diasSinMantenimiento = 180;
    if (vehiculo[0].ultimo_mantenimiento) {
        const ultimo = new Date(vehiculo[0].ultimo_mantenimiento);
        const ahora = new Date();
        diasSinMantenimiento = Math.floor((ahora - ultimo) / (1000 * 60 * 60 * 24));
    }

    const { rows: fallas } = await client.query(
        'SELECT COUNT(*) as total FROM componentes WHERE vehiculo_id = $1 AND estado IN ($2, $3)',
        [vehiculoId, 'MALO', 'CRITICO']
    );

    const { rows: componentes } = await client.query(
        'SELECT estado FROM componentes WHERE vehiculo_id = $1',
        [vehiculoId]
    );

    let puntajeComponentes = 0;
    const pesos = { 'EXCELENTE': 0, 'BUENO': 1, 'REGULAR': 2, 'MALO': 3, 'CRITICO': 4 };

    componentes.forEach(c => {
        puntajeComponentes += pesos[c.estado] || 0;
    });

    puntajeComponentes = componentes.length ? (puntajeComponentes / componentes.length) * 25 : 0;

    const kmPuntaje = Math.min((vehiculo[0].kilometraje / 200000) * 25, 25);
    const tiempoPuntaje = Math.min((diasSinMantenimiento / 365) * 25, 25);
    const fallasPuntaje = Math.min(fallas[0].total * 5, 25);
    const usoPuntaje = { 'BAJA': 5, 'MEDIA': 15, 'ALTA': 25 }[vehiculo[0].frecuencia_uso] || 10;

    const puntajeTotal = Math.round(kmPuntaje + tiempoPuntaje + fallasPuntaje + puntajeComponentes + usoPuntaje);

    let clasificacion;
    if (puntajeTotal >= 80) clasificacion = 'CRITICO';
    else if (puntajeTotal >= 60) clasificacion = 'ALTO';
    else if (puntajeTotal >= 40) clasificacion = 'MEDIO';
    else clasificacion = 'BAJO';

    await client.query(
        `INSERT INTO priorizaciones 
        (vehiculo_id, kilometraje_puntos, mantenimiento_puntos, fallas_puntos, componentes_puntos, uso_puntos, puntaje_total, clasificacion) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [vehiculoId, kmPuntaje, tiempoPuntaje, fallasPuntaje, puntajeComponentes, usoPuntaje, puntajeTotal, clasificacion]
    );

    await client.query('UPDATE vehiculos SET criticidad = $1 WHERE id = $2', [clasificacion, vehiculoId]);

    if (clasificacion === 'CRITICO') {
        const { rows: existe } = await client.query(
            'SELECT id FROM alertas WHERE vehiculo_id = $1 AND nivel = $2 AND fecha > NOW() - INTERVAL \'1 day\'',
            [vehiculoId, 'CRITICO']
        );

        if (existe.length === 0) {
            await client.query(
                `INSERT INTO alertas (vehiculo_id, nivel, mensaje) 
                VALUES ($1, $2, $3)`,
                [vehiculoId, 'CRITICO', `⚠️ ALERTA CRÍTICA: Vehículo requiere mantenimiento urgente. Puntaje total: ${puntajeTotal}/100`]
            );
        }
    }

    return { puntajeTotal, clasificacion };
}

// ============================================
// ENDPOINTS DE VEHÍCULOS
// ============================================
app.get('/api/vehicles', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM vehiculos ORDER BY id DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/vehicles/:id', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM vehiculos WHERE id = $1', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Vehículo no encontrado' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/vehicles', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general } = req.body;

        const { rows } = await client.query(
            `INSERT INTO vehiculos (placa, marca, modelo, anio, kilometraje, capacidad_carga, frecuencia_uso, estado_general)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [placa, marca, modelo, anio || null, kilometraje || 0, capacidad_carga || 0, frecuencia_uso || 'MEDIA', estado_general || 'OPERATIVO']
        );

        const componentes = ['AMORTIGUADOR', 'RESORTE', 'ROTULA', 'BUJE', 'BRAZO_SUSPENSION', 'BARRA_ESTABILIZADORA'];
        for (const comp of componentes) {
            await client.query(
                'INSERT INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion) VALUES ($1, $2, $3, CURRENT_DATE)',
                [rows[0].id, comp, 'BUENO']
            );
        }

        await client.query('COMMIT');
        res.json({ id: rows[0].id, mensaje: 'Vehículo registrado exitosamente' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// ============================================
// ENDPOINTS DE COMPONENTES
// ============================================
app.get('/api/components', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT c.*, v.placa FROM componentes c JOIN vehiculos v ON c.vehiculo_id = v.id');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/components', async (req, res) => {
    try {
        const { vehiculo_id, nombre, estado, observaciones } = req.body;
        const { rows } = await pool.query(
            'INSERT INTO componentes (vehiculo_id, nombre, estado, fecha_inspeccion, observaciones) VALUES ($1, $2, $3, CURRENT_DATE, $4) RETURNING id',
            [vehiculo_id, nombre, estado, observaciones]
        );
        await calcularCriticidad(vehiculo_id, pool);
        res.json({ id: rows[0].id, mensaje: 'Componente registrado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE MANTENIMIENTOS
// ============================================
app.get('/api/maintenances', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT m.*, v.placa FROM mantenimientos m JOIN vehiculos v ON m.vehiculo_id = v.id ORDER BY m.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/maintenances', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { vehiculo_id, tecnico_id, tipo, fecha, costo, kilometraje, descripcion } = req.body;
        const { rows } = await client.query(
            'INSERT INTO mantenimientos (vehiculo_id, tecnico_id, tipo, fecha, costo, descripcion) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [vehiculo_id, tecnico_id, tipo, fecha, costo, descripcion]
        );
        await client.query('UPDATE vehiculos SET kilometraje = $1, ultimo_mantenimiento = $2 WHERE id = $3', [kilometraje, fecha, vehiculo_id]);
        await client.query('COMMIT');
        await calcularCriticidad(vehiculo_id, pool);
        res.json({ id: rows[0].id, mensaje: 'Mantenimiento registrado' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// ============================================
// ENDPOINTS DE ALERTAS
// ============================================
app.get('/api/alerts', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT a.*, v.placa FROM alertas a JOIN vehiculos v ON a.vehiculo_id = v.id ORDER BY a.fecha DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/alerts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM alertas WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Alerta eliminada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE USUARIOS
// ============================================
app.get('/api/users', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, nombre, correo, rol, estado FROM usuarios');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const { nombre, correo, password, rol } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            'INSERT INTO usuarios (nombre, correo, password, rol, estado) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [nombre, correo, hashedPassword, rol, 'ACTIVO']
        );
        res.json({ id: rows[0].id, mensaje: 'Usuario creado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// ENDPOINTS DE DASHBOARD
// ============================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const { rows: vehiculos } = await pool.query('SELECT COUNT(*) as total FROM vehiculos');
        const { rows: operativos } = await pool.query('SELECT COUNT(*) as total FROM vehiculos WHERE estado_general = $1', ['OPERATIVO']);
        const { rows: criticos } = await pool.query('SELECT COUNT(*) as total FROM vehiculos WHERE criticidad = $1', ['CRITICO']);
        const { rows: costos } = await pool.query('SELECT COALESCE(SUM(costo), 0) as total FROM mantenimientos WHERE EXTRACT(YEAR FROM fecha) = EXTRACT(YEAR FROM CURRENT_DATE)');

        res.json({
            total_vehiculos: parseInt(vehiculos[0].total),
            vehiculos_operativos: parseInt(operativos[0].total),
            vehiculos_criticos: parseInt(criticos[0].total),
            costos_acumulados: parseFloat(costos[0].total),
            mantenimientos_realizados: 0,
            mantenimientos_pendientes: 0,
            componentes_desgaste: [],
            alertas_recientes: []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// REPORTES
// ============================================
app.get('/api/reports/generate', async (req, res) => {
    try {
        const { tipo, formato } = req.query;

        if (formato === 'pdf') {
            const doc = new PDFDocument();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=reporte_${tipo}.pdf`);
            doc.pipe(res);
            doc.fontSize(20).text('SuspenTrack - Reporte', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Tipo: ${tipo}`);
            doc.text(`Fecha: ${new Date().toLocaleDateString()}`);
            doc.end();
        } else {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Reporte');
            worksheet.columns = [{ header: 'Dato', key: 'dato' }, { header: 'Valor', key: 'valor' }];
            worksheet.addRow({ dato: 'Tipo de reporte', valor: tipo });
            worksheet.addRow({ dato: 'Fecha generación', valor: new Date().toLocaleDateString() });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=reporte_${tipo}.xlsx`);
            await workbook.xlsx.write(res);
            res.end();
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 SuspenTrack corriendo en http://localhost:${PORT}`);
});