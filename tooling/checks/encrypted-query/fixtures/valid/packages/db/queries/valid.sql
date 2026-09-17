SELECT fund_id, SUM(amount_minor) AS total
FROM app.donations
WHERE donor_person_id = $1
GROUP BY fund_id
ORDER BY amount_minor DESC;
